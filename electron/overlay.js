// Glass-bar overlay renderer. The user types a question; the main process
// silently captures the screen, sends it to LYKN, and streams the answer back
// here. The screenshot itself is never shown.

// Windows/Linux lack native vibrancy — denser glass CSS (see overlay.html).
if (window.lyknOverlay?.platform && window.lyknOverlay.platform !== "darwin") {
  document.documentElement.classList.add("no-vibrancy");
}

const askEl = document.getElementById("ask");
const sendEl = document.getElementById("send");
const threadEl = document.getElementById("thread");
const dotEl = document.getElementById("dot");

let busy = false;
// The answer element of the turn currently streaming, so deltas land in the
// right place even after older turns have been collapsed.
let currentAnswerEl = null;
// The turn's container + question text, used to attach suggestions on done.
let currentChatEl = null;
let currentQuestion = "";
let currentPageSource = null;
// Whether the current turn has started receiving answer text (vs still showing
// the thinking/tool spinner).
let currentHasText = false;
// Lightweight conversation memory so follow-ups ("what about the error?") have
// context. Capped on the main side too. Persisted locally as ⌘L sessions.
const history = [];
let currentSessionId = null;

const CHEVRON_SVG =
  '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m6 9 6 6 6-6" /></svg>';

// The LYKN icon outline used by the chat page's loading spinner.
const SPINNER_PATH =
  "M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z";

function thinkingHTML(status) {
  return (
    '<div class="thinking">' +
    '<svg class="lykn-outline-spinner" width="24" height="24" viewBox="0 0 204.29 204.29" ' +
    'fill="none" role="img" aria-label="Loading">' +
    '<path d="' + SPINNER_PATH + '" pathLength="1" fill="currentColor" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />' +
    "</svg>" +
    '<span class="thinking-text"></span>' +
    "</div>"
  );
}

// Client-side status rotation (mirrors src/hooks/useThinkingStatus.js) so Build
// mode doesn't freeze on a bare "Building…" the way Research narrates steps.
const THINK_PHASES = [
  { text: "Thinking…", duration: 1600 },
  { text: "Reading what you said…", duration: 1800 },
  { text: "Pulling together context…", duration: 2000 },
  { text: "Working through it…", duration: 2200 },
  { text: "Reasoning it out…", duration: 2400 },
  { text: "Connecting the pieces…", duration: 2600 },
  { text: "Putting it together…", duration: 2800 },
  { text: "Almost there…", duration: 3200 },
  { text: "Polishing the details…", duration: 6000 },
];
const BUILD_PHASES = [
  { text: "Designing the build…", duration: 1800 },
  { text: "Sketching the layout…", duration: 2000 },
  { text: "Building out the sections…", duration: 2200 },
  { text: "Wiring the interactions…", duration: 2400 },
  { text: "Assembling the pieces…", duration: 2600 },
  { text: "Polishing the details…", duration: 3000 },
  { text: "Almost ready…", duration: 4000 },
  { text: "Putting on the finishing touches…", duration: 6000 },
];
const GENERIC_THINK_RE =
  /^(thinking|working(?:\son\sit)?|loading|please\swait|one\smoment|responding)[\s.…]*$/i;
const GENERIC_BUILD_RE =
  /^(building(?:\sthe\s(?:app|page|artifact|sections))?|running\stools|designing\sthe\sbuild|sketching\sthe\slayout|building\sout\sthe\ssections|writing\sthe\scode|wiring\sthe\sinteractions|assembling\sthe\spieces|drafting\sthe\sdocument|composing\sthe\svideo|laying\sout\sthe\sspreadsheet|almost\sready|putting\son\sthe\sfinishing\stouches)[\s.…]*$/i;

let statusRotateTimer = null;
let statusRotateIndex = 0;
let statusRotateLane = "think";
let statusRotateActive = false;

function stopStatusRotation(opts) {
  statusRotateActive = false;
  if (statusRotateTimer) {
    clearTimeout(statusRotateTimer);
    statusRotateTimer = null;
  }
  statusRotateIndex = 0;
  if (!opts || opts.resetLane !== false) {
    statusRotateLane = "think";
  }
}

function shouldKeepBuildingUnder() {
  // Once the model is talking, only keep the spinner for build/tool work —
  // not the generic "Thinking…" rotation under a finished (or finishing) reply.
  return answerStillWorking && statusRotateLane === "build";
}

function applyRotatedStatus(text) {
  lastThinkingStatus = text;
  if (!currentHasText) {
    const el = currentAnswerEl && currentAnswerEl.querySelector(".thinking-text");
    if (el) el.textContent = text;
  } else if (shouldKeepBuildingUnder()) {
    ensureBuildingUnder(text);
  }
}

function tickStatusRotation() {
  if (!statusRotateActive || !answerStillWorking) {
    stopStatusRotation({ resetLane: false });
    return;
  }
  const phases = statusRotateLane === "build" ? BUILD_PHASES : THINK_PHASES;
  if (statusRotateIndex >= phases.length - 1) return;
  statusRotateTimer = setTimeout(() => {
    statusRotateIndex = Math.min(statusRotateIndex + 1, phases.length - 1);
    applyRotatedStatus(phases[statusRotateIndex].text);
    tickStatusRotation();
  }, phases[statusRotateIndex].duration);
}

function startStatusRotation(lane) {
  const nextLane =
    lane === "build" || statusRotateLane === "build" ? "build" : "think";
  if (statusRotateActive && statusRotateLane === nextLane) return;
  stopStatusRotation({ resetLane: false });
  statusRotateActive = true;
  statusRotateLane = nextLane;
  statusRotateIndex = 0;
  const phases = nextLane === "build" ? BUILD_PHASES : THINK_PHASES;
  applyRotatedStatus(phases[0].text);
  tickStatusRotation();
}

function maybeRotateFromStatus(text) {
  const t = String(text || "").trim();
  if (!t) return;
  if (
    GENERIC_BUILD_RE.test(t) ||
    /^(building|designing|drafting|composing|writing|laying\sout|wiring|assembling|putting\stogether)/i.test(t)
  ) {
    if (GENERIC_BUILD_RE.test(t)) {
      startStatusRotation("build");
    } else {
      // Detail-rich build line — show it, remember the lane, pause rotation.
      stopStatusRotation({ resetLane: false });
      statusRotateLane = "build";
    }
    return;
  }
  if (GENERIC_THINK_RE.test(t)) {
    startStatusRotation(statusRotateLane === "build" ? "build" : "think");
    return;
  }
  stopStatusRotation({ resetLane: false });
}

// ── Minimal, safe Markdown → HTML for answers ──────────────────────────────
// The model replies in Markdown (## headers, **bold**, - bullets, 1. lists,
// `code`). We escape first so model output can't inject HTML, then build a small
// set of block/inline elements. Good enough for chat answers without a library.
function escapeHtml(s) {
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
function escapeAttr(s) {
  return escapeHtml(s);
}

/** Undo escapeHtml so media URLs with &query= params stay valid in src/href. */
function unescapeHtml(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Only allow https artifact/image hosts we mint, plus chart/diagram previews. */
function isAllowedMediaUrl(url) {
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

function renderInline(s) {
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
const expandedAgentSteps = new Set();

/** Reasoning arrives as one line of " · "-joined parts; show them as lines. */
function splitStepDetail(detail) {
  return String(detail || "")
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderMarkdown(md) {
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
        let kind = "vault";
        let itemId = "";
        const vaultMatch = /^lykn-vault:\/\/([^/]+)\/(.+)$/i.exec(mediaUrl);
        if (vaultMatch) {
          try {
            kind = decodeURIComponent(vaultMatch[1]) || "vault";
            itemId = decodeURIComponent(vaultMatch[2]) || "";
          } catch {
            kind = vaultMatch[1] || "vault";
            itemId = vaultMatch[2] || "";
          }
        }
        const vaultTitle =
          altText.replace(/^lykn[-_]vault\s*:/i, "").trim() || "Saved item";
        const kindLabel =
          kind === "belief"
            ? "Belief"
            : kind === "fact"
              ? "Fact"
              : kind === "concept"
                ? "Concept"
                : "Vault";
        const safeTitle = escapeHtml(vaultTitle);
        const safeKindLabel = escapeHtml(kindLabel);
        const safeId = escapeAttr(itemId);
        const safeKind = escapeAttr(kind);
        const safePreview = previewText
          ? `<div class="md-vault-preview">${escapeHtml(previewText)}</div>`
          : "";
        const openAttrs =
          kind === "vault"
            ? `data-kind="vault"${itemId ? ` data-note-id="${safeId}"` : ""}`
            : `data-kind="${safeKind}" data-synthesis="1"`;
        html +=
          `<div class="md-vault" ${openAttrs}>` +
          `<div class="md-vault-head"><span class="md-vault-kind">${safeKindLabel}</span>` +
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

const LINK_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />' +
  '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>';

const ARROW_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M7 7h10v10" /><path d="M7 17 17 7" /></svg>';

// Hidden state store for the detached side-panel card (see panel.html).
const sideInnerEl = document.getElementById("side-inner");
const sidePickerBtnEl = document.getElementById("side-picker-btn");
const sidePickerLabelEl = document.getElementById("side-picker-label");

const SIDE_VIEW_OPTIONS = [
  { id: "", label: "None" },
  { id: "watch", label: "Live feedback" },
  { id: "all", label: "All" },
  { id: "sources", label: "Sources" },
  { id: "tasks", label: "Tasks" },
  { id: "followups", label: "Follow-ups" },
  { id: "notes", label: "Notes" },
];

let sideContext = null;
let lastAnswerText = "";
let liveNotesSnapshot = {
  keyPoints: [],
  actionItems: [],
  summary: "",
  questionsToAsk: [],
  suggestions: [],
  topics: [],
};
let sidePanelView = "";
let panelPickerOpen = false;
// Live watch feed — rendered in the side panel, not the chat thread.
let watchFeedItems = [];
let watchActiveRules = [];
let watchContextSource = "vision";
let watchExtensionConnected = false;
let watchPageTitle = "";
let watchPageUrl = "";
let watchConnPollTimer = null;

function startWatchConnPoll() {
  if (watchConnPollTimer) return;
  watchConnPollTimer = setInterval(async () => {
    if (!liveWatchEnabled) return;
    try {
      const status = await window.lyknOverlay.getLiveWatch();
      const next = !!status?.extensionConnected;
      if (next !== watchExtensionConnected) {
        watchExtensionConnected = next;
        if (sidePanelView === "watch") renderWatchSidePanel();
      }
    } catch (_) {}
  }, 2000);
}

function stopWatchConnPoll() {
  if (watchConnPollTimer) clearInterval(watchConnPollTimer);
  watchConnPollTimer = null;
}
let liveWatchEnabled = false;
let lastWatchCommentaryPosted = "";
let watchFeedActive = false;
let watchSuggestions = { followups: [], links: [] };
let watchSuggestTimer = null;
let lastWatchSuggestKey = "";

function dedupeStrings(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items || []) {
    const s = String(raw || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function extractTasksFromAnswer(text) {
  const lines = String(text || "").split("\n");
  const tasks = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^#+\s*(action|task|todo)/i.test(t) || /^action items?:/i.test(t)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^#+\s/.test(t) && !/^#+\s*(action|task|todo)/i.test(t)) inBlock = false;
    const box = t.match(/^[-*]\s*\[[ xX]?\]\s*(.+)/);
    if (box) {
      tasks.push(box[1].trim());
      continue;
    }
    if (inBlock) {
      const bullet = t.match(/^[-*•]\s+(.+)/);
      if (bullet) tasks.push(bullet[1].trim());
    }
  }
  return tasks;
}

function extractNotesFromAnswer(text) {
  const lines = String(text || "").split("\n");
  const notes = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^#+\s*(key point|summary|note|highlight)/i.test(t) || /^key points?:/i.test(t)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^#+\s/.test(t) && !/^#+\s*(key point|summary|note|highlight)/i.test(t)) inBlock = false;
    const bullet = t.match(/^[-*•]\s+(?!\[[ xX]?\])(.+)/);
    if (inBlock && bullet) notes.push(bullet[1].trim());
  }
  return notes;
}

function buildSideData() {
  const tasks = dedupeStrings([
    ...extractTasksFromAnswer(lastAnswerText),
    ...(liveNotesSnapshot.actionItems || []),
  ]);
  const notes = dedupeStrings([
    ...(liveNotesSnapshot.keyPoints || []),
    ...(liveNotesSnapshot.suggestions || []),
    ...extractNotesFromAnswer(lastAnswerText),
  ]);
  const followups = dedupeStrings([
    ...((sideContext && sideContext.followups) || []),
    ...(liveNotesSnapshot.questionsToAsk || []),
  ]);
  return {
    pageSource: sideContext && sideContext.pageSource ? sideContext.pageSource : null,
    links: (sideContext && sideContext.links) || [],
    followups,
    tasks,
    notes,
    summary: String(liveNotesSnapshot.summary || "").trim(),
  };
}

function sideViewCount(viewId, data) {
  if (!data) return 0;
  switch (viewId) {
    case "watch":
      return watchFeedItems.filter((i) => !i.system).length;
    case "sources":
      return (data.pageSource && data.pageSource.url ? 1 : 0) + data.links.length;
    case "tasks":
      return data.tasks.length;
    case "followups":
      return data.followups.length;
    case "notes":
      return data.notes.length + (data.summary ? 1 : 0);
    case "all":
      return (
        sideViewCount("watch", data) +
        sideViewCount("sources", data) +
        sideViewCount("tasks", data) +
        sideViewCount("followups", data) +
        sideViewCount("notes", data)
      );
    default:
      return 0;
  }
}

function updateSidePickerLabel() {
  const opt = SIDE_VIEW_OPTIONS.find((o) => o.id === sidePanelView);
  sidePickerLabelEl.textContent = opt ? opt.label : "None";
}

// The view picker lives in its OWN little vibrancy window next to the bar
// (see picker.html / main.cjs), exactly like the three-dot menu. This just
// asks main to show/hide it; main echoes the actual visibility back via
// onPickerVisible so `panelPickerOpen` never drifts.
function setPanelPickerOpen(open) {
  try {
    window.lyknOverlay.setPicker(!!open);
  } catch (_) {}
}

function closeSidePickerMenu() {
  setPanelPickerOpen(false);
  // Drop focus so the trigger doesn't keep the open/active tint after selection.
  sidePickerBtnEl.blur();
}

window.lyknOverlay.onPickerVisible((visible) => {
  panelPickerOpen = !!visible;
  sidePickerBtnEl.classList.toggle("active", panelPickerOpen);
  sidePickerBtnEl.setAttribute("aria-expanded", panelPickerOpen ? "true" : "false");
  if (!panelPickerOpen) sidePickerBtnEl.blur();
});

// Remote control from the picker window — the pick is applied HERE because
// this renderer owns the side-panel state and rendering.
window.__lyknPickerSelect = (id) => {
  setSidePanelView(id);
};

// Options snapshot (labels, counts, active view) for the picker card.
window.__lyknPickerState = () => {
  const data = buildSideData();
  const options = [];
  for (const opt of SIDE_VIEW_OPTIONS) {
    if (opt.id === "watch" && !liveWatchEnabled) continue;
    options.push({
      id: opt.id,
      label: opt.label,
      count: opt.id ? sideViewCount(opt.id, data) : 0,
    });
  }
  return { options, active: sidePanelView };
};

function syncSidePickerState() {
  updateSidePickerLabel();
}

// The side-panel content lives in its OWN vibrancy window floating next to
// the bar (see panel.html / main.cjs), like the three-dot menu and the live
// notes card — so it reads as a separate glass card instead of widening the
// chat bar. The hidden #side-inner DOM here stays the source of truth; we
// push HTML snapshots over and receive user actions back (__lyknPanelCmd).
function showSide(open) {
  if (open && !sidePanelView) return;
  try {
    window.lyknOverlay.setPanel(!!open);
  } catch (_) {}
  if (open) pushPanelState();
}

function sidePanelTitle() {
  const opt = SIDE_VIEW_OPTIONS.find((o) => o.id === sidePanelView);
  return opt && opt.id ? opt.label : "Panel";
}

function pushPanelState() {
  if (!sidePanelView) return;
  try {
    window.lyknOverlay.pushPanel({
      title: sidePanelTitle(),
      html: sideInnerEl.innerHTML,
      width: sidePanelView === "watch" ? WATCH_SIDE_WIDTH : SIDE_WIDTH,
      scrollBottom: sidePanelView === "watch",
    });
  } catch (_) {}
}

// Remote control from the panel card — actions run HERE because this
// renderer owns the side-panel data (and the composer for follow-ups).
window.__lyknPanelCmd = (name, arg) => {
  switch (name) {
    case "close":
      setSidePanelView("");
      break;
    case "url":
      try {
        const raw = arg;
        if (raw && typeof raw === "object") {
          window.lyknOverlay.openUrl(String(raw.url || ""), raw.title || undefined);
        } else {
          window.lyknOverlay.openUrl(String(raw || ""));
        }
      } catch (_) {}
      break;
    case "ask":
      askEl.value = String(arg || "");
      ask();
      break;
    case "install":
      try {
        window.lyknOverlay.openExtensionInstall?.().catch(() => {});
      } catch (_) {}
      break;
    default:
      break;
  }
};

function clearSide() {
  sideInnerEl.innerHTML = "";
  sideContext = null;
  lastAnswerText = "";
  researchSources = [];
  sidePanelView = "";
  closeSidePickerMenu();
  updateSidePickerLabel();
  showSide(false);
  syncSidePickerState();
}

// Reset per-turn research state for a new chat turn. The panel card stays
// OPEN on whatever view the user picked (it only closes from its X or the
// picker) — prior sources remain in sideContext until the new answer
// delivers its own (onSources / requestSuggestions) or the user starts a
// new chat (clearSide).
let researchSources = [];

function resetSideForNewTurn() {
  lastAnswerText = "";
  researchSources = [];
  if (liveWatchEnabled && !sidePanelView) setSidePanelView("watch");
}

function mergeSourceLinks(base, extra) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(base || []), ...(extra || [])]) {
    if (!raw || !raw.url) continue;
    const url = String(raw.url).trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(raw.title || url).trim().slice(0, 160) || url,
      url,
    });
  }
  return out;
}

function setSidePanelView(viewId) {
  sidePanelView = viewId || "";
  updateSidePickerLabel();
  if (!sidePanelView) {
    showSide(false);
    return;
  }
  renderSidePanel();
  showSide(true);
}

sidePickerBtnEl.addEventListener("click", (e) => {
  e.stopPropagation();
  setPanelPickerOpen(!panelPickerOpen);
});

document.addEventListener("click", (e) => {
  if (panelPickerOpen && !e.target.closest("#composer")) closeSidePickerMenu();
});

function sideTextItem(text) {
  const el = document.createElement("div");
  el.className = "side-text-item";
  el.textContent = text;
  return el;
}

function appendSourcesSection(data, target) {
  let added = false;
  if (data.pageSource && data.pageSource.url) {
    const { sec, list } = sideSection("Read this page");
    list.appendChild(sourceCard(data.pageSource));
    target.appendChild(sec);
    added = true;
  }
  if (data.links.length) {
    const { sec, list } = sideSection("Sources");
    // Show every collected source (stream/deep-research caps upstream).
    for (const l of data.links) list.appendChild(sourceCard(l));
    target.appendChild(sec);
    added = true;
  }
  return added;
}

function appendTasksSection(data, target) {
  if (!data.tasks.length) return false;
  const { sec, list } = sideSection("Tasks");
  for (const t of data.tasks.slice(0, 8)) list.appendChild(sideTextItem(t));
  target.appendChild(sec);
  return true;
}

function appendFollowupsSection(data, target) {
  if (!data.followups.length) return false;
  const { sec, list } = sideSection("Follow-ups");
  for (const f of data.followups.slice(0, 4)) {
    list.appendChild(
      optionButton(f, ARROW_ICON_SVG, () => {
        askEl.value = f;
        ask();
      }),
    );
  }
  target.appendChild(sec);
  return true;
}

function appendNotesSection(data, target) {
  let added = false;
  if (data.summary) {
    const { sec, list } = sideSection("Summary");
    const el = document.createElement("div");
    el.className = "side-summary";
    el.textContent = data.summary;
    list.appendChild(el);
    target.appendChild(sec);
    added = true;
  }
  if (data.notes.length) {
    const { sec, list } = sideSection("Notes");
    for (const n of data.notes.slice(0, 8)) list.appendChild(sideTextItem(n));
    target.appendChild(sec);
    added = true;
  }
  return added;
}

function watchSourceLabel() {
  if (watchContextSource === "extension") return "via extension (text)";
  if (watchContextSource === "scrape") return "via browser text";
  return "via screen";
}

function appendWatchSuggestionsSection(target) {
  const followups = (watchSuggestions.followups || []).filter(Boolean);
  const links = (watchSuggestions.links || []).filter((l) => l && l.url);
  let added = false;
  if (followups.length) {
    const { sec, list } = sideSection("Suggestions");
    for (const f of followups.slice(0, 4)) {
      list.appendChild(
        optionButton(f, ARROW_ICON_SVG, () => {
          askEl.value = f;
          ask();
        }),
      );
    }
    target.appendChild(sec);
    added = true;
  }
  if (links.length) {
    const { sec, list } = sideSection("Sources");
    for (const l of links.slice(0, 4)) list.appendChild(sourceCard(l));
    target.appendChild(sec);
    added = true;
  }
  return added;
}

function appendWatchSideSection(target) {
  if (!watchFeedActive && !watchFeedItems.length) return false;
  const { sec, list } = sideSection("Live feedback");
  if (!watchExtensionConnected && watchFeedActive) {
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "watch-install-btn";
    installBtn.textContent = "Add Chrome Live Feed";
    installBtn.addEventListener("click", () => {
      window.lyknOverlay.openExtensionInstall?.().catch(() => {});
    });
    list.appendChild(installBtn);
  }
  if (watchActiveRules.length) {
    const rulesEl = document.createElement("div");
    rulesEl.className = "watch-side-rules";
    rulesEl.textContent = `Alerts: ${watchActiveRules.join(" · ")}`;
    list.appendChild(rulesEl);
  }
  if (!watchFeedItems.length) {
    list.appendChild(sideTextItem("Analyzing screen…"));
  } else {
    for (const item of watchFeedItems.slice(-24)) {
      const row = document.createElement("div");
      row.className =
        "watch-side-item" +
        (item.system ? " system" : "") +
        (item.alert ? " alert" : "");
      const body = document.createElement("div");
      body.className = "watch-side-text";
      body.textContent = item.text;
      if (item.alert || item.system) {
        const meta = document.createElement("div");
        meta.className = "watch-side-meta";
        meta.textContent = item.alert ? "Alert" : "Live feedback";
        row.appendChild(meta);
      }
      row.appendChild(body);
      list.appendChild(row);
    }
  }
  target.appendChild(sec);
  appendWatchSuggestionsSection(target);
  return true;
}

function renderWatchSidePanel() {
  sideInnerEl.innerHTML = "";
  if (watchExtensionConnected && watchFeedActive) {
    const banner = document.createElement("div");
    banner.className = "watch-connected-banner";
    banner.textContent = "Chrome Live Feed connected";
    sideInnerEl.appendChild(banner);
  }
  if (!appendWatchSideSection(sideInnerEl)) {
    const empty = document.createElement("div");
    empty.className = "side-empty";
    empty.textContent = "Live feedback is off.";
    sideInnerEl.appendChild(empty);
  }
  pushPanelState();
}

function renderSidePanel() {
  if (sidePanelView === "watch") {
    renderWatchSidePanel();
    return;
  }
  const data = buildSideData();
  sideInnerEl.innerHTML = "";
  const views =
    sidePanelView === "all"
      ? ["watch", "sources", "tasks", "followups", "notes"]
      : [sidePanelView];
  let added = false;
  for (const view of views) {
    switch (view) {
      case "watch":
        added = appendWatchSideSection(sideInnerEl) || added;
        break;
      case "sources":
        added = appendSourcesSection(data, sideInnerEl) || added;
        break;
      case "tasks":
        added = appendTasksSection(data, sideInnerEl) || added;
        break;
      case "followups":
        added = appendFollowupsSection(data, sideInnerEl) || added;
        break;
      case "notes":
        added = appendNotesSection(data, sideInnerEl) || added;
        break;
      default:
        break;
    }
  }
  if (!added) {
    const empty = document.createElement("div");
    empty.className = "side-empty";
    empty.textContent = "Nothing here yet.";
    sideInnerEl.appendChild(empty);
  }
  pushPanelState();
}

function refreshSidePanelFromLiveNotes() {
  syncSidePickerState();
  if (sidePanelView) renderSidePanel();
}

// Build a labeled section with a vertical list of items.
function sideSection(title) {
  const sec = document.createElement("div");
  sec.className = "side-sec";
  const lab = document.createElement("div");
  lab.className = "side-title";
  lab.textContent = title;
  const list = document.createElement("div");
  list.className = "side-list";
  sec.append(lab, list);
  return { sec, list };
}

function sourceCard(link) {
  let host = "";
  try {
    host = new URL(link.url).hostname.replace(/^www\./, "");
  } catch (_) {
    host = "";
  }
  const a = document.createElement("button");
  a.className = "suggest-link";
  a.type = "button";
  a.title = link.url;
  // The detached panel card renders this markup via innerHTML snapshots, so
  // it needs the URL as data (its click delegation can't see this listener).
  a.dataset.url = link.url;
  if (link.title) a.dataset.title = link.title;

  const fav = document.createElement("span");
  fav.className = "suggest-fav";
  if (host) {
    const img = document.createElement("img");
    img.className = "suggest-fav-img";
    img.loading = "lazy";
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    img.addEventListener("error", () => {
      fav.classList.add("fallback");
      fav.innerHTML = LINK_ICON_SVG;
    });
    fav.appendChild(img);
  } else {
    fav.classList.add("fallback");
    fav.innerHTML = LINK_ICON_SVG;
  }

  const txt = document.createElement("span");
  txt.className = "suggest-link-col";
  const title = document.createElement("span");
  title.className = "suggest-link-title";
  title.textContent = link.title || host || link.url;
  const dom = document.createElement("span");
  dom.className = "suggest-link-domain";
  dom.textContent = host;
  txt.append(title, dom);

  a.append(fav, txt);
  a.addEventListener("click", () =>
    window.lyknOverlay.openUrl(link.url, link.title || host || undefined),
  );
  return a;
}

function optionButton(label, iconSvg, onClick) {
  const b = document.createElement("button");
  b.className = "suggest-chip";
  b.type = "button";
  const span = document.createElement("span");
  span.textContent = label;
  const ico = document.createElement("span");
  ico.className = "suggest-chip-ico";
  ico.innerHTML = iconSvg;
  b.append(span, ico);
  b.addEventListener("click", onClick);
  return b;
}

// After an answer, cache panel data; the user picks a view from the dropdown.
async function requestSuggestions(question, answer) {
  if (!answer || answer.trim().length < 20) return;
  let data = null;
  try {
    data = await window.lyknOverlay.suggest(question, answer);
  } catch (_) {
    data = null;
  }
  const suggested = (data && Array.isArray(data.links) ? data.links : []).filter((l) => l && l.url);
  const priorLinks = (sideContext && sideContext.links) || [];
  const stepOnly = /lykn-agent-step:\/\//i.test(String(answer || ""));
  // This turn's deep-research sources replace the list; otherwise keep prior
  // sources so a follow-up prompt doesn't wipe the Sources panel.
  // Step-box transcripts are not a source list — don't invent links from them.
  const links = stepOnly
    ? []
    : researchSources.length
      ? mergeSourceLinks(researchSources, suggested)
      : mergeSourceLinks(priorLinks, suggested);
  const followups = (data && Array.isArray(data.followups) ? data.followups : []).filter(Boolean);

  lastAnswerText = answer;
  sideContext = {
    pageSource:
      (currentPageSource && currentPageSource.url && currentPageSource) ||
      (sideContext && sideContext.pageSource) ||
      null,
    links,
    followups: followups.length ? followups : (sideContext && sideContext.followups) || [],
  };

  syncSidePickerState();
  // Keep Sources data ready, but never auto-open the panel — user picks it.
  if (sidePanelView && sidePanelView !== "watch") renderSidePanel();
}

// Width must match the main process constant (OVERLAY_WIDTH); the panel card
// widths match the detached panel window (see panel.html / main.cjs).
const CHAT_WIDTH = 520;
const SIDE_WIDTH = 300;
const WATCH_SIDE_WIDTH = 360;
let lastReportedHeight = -1;
let lastReportedWidth = -1;

// The live watch feed renders in the detached panel card now, so the chat
// bar itself never stretches — just open the watch view.
function applyLiveWatchLayout(on) {
  if (on) {
    if (sidePanelView !== "watch") setSidePanelView("watch");
    else {
      renderWatchSidePanel();
      showSide(true);
    }
  }
}

// The live meeting notes card lives in its OWN vibrancy window floating next
// to the bar (see live.html / main.cjs), like the three-dot menu — so it never
// stretches the chat bar or bleeds into the composer. This renderer keeps the
// hidden #live DOM as the state store and pushes render snapshots to the card.
let liveNotesOpen = false;
function applyLiveNotesLayout(on) {
  liveNotesOpen = !!on;
  try {
    window.lyknOverlay.setLive(liveNotesOpen);
  } catch (_) {}
  if (liveNotesOpen) pushLiveState();
}

// Clean-bar toggle: ON hides every previous turn ENTIRELY so only the newest
// prompt + answer shows (the turns stay in the DOM and `history` is untouched,
// so the AI keeps full context); OFF brings the older prompts back as the
// usual collapsed headers. While ON the button stays visible and tinted so it
// can be toggled back off even with nothing expanded.
const collapseAllBtn = document.getElementById("collapse-all");
function refreshCollapseAllBtn() {
  if (!collapseAllBtn) return;
  const clean = threadEl.classList.contains("clean");
  const chatCount = threadEl.querySelectorAll(".chat").length;
  // Visible whenever there's history worth hiding (2+ turns), regardless of
  // whether anything is expanded — and always while clean mode is on, so it
  // can be toggled back off.
  const show = threadEl.classList.contains("show") && (clean || chatCount >= 2);
  collapseAllBtn.classList.toggle("show", show);
  collapseAllBtn.classList.toggle("active", clean);
}
if (collapseAllBtn) {
  collapseAllBtn.addEventListener("click", () => {
    const on = !threadEl.classList.contains("clean");
    threadEl.classList.toggle("clean", on);
    const label = on ? "Show previous chats" : "Hide previous chats";
    collapseAllBtn.title = label;
    collapseAllBtn.setAttribute("aria-label", label);
    if (on) {
      // Fold everything, then open just the newest turn — the clean bar shows
      // exactly one prompt + its response.
      threadEl.querySelectorAll(".chat").forEach((c) => c.classList.add("collapsed"));
      const last = threadEl.querySelector(".chat:last-child");
      if (last) last.classList.remove("collapsed");
    }
    refreshCollapseAllBtn();
    reportHeight();
  });
}

function reportHeight() {
  // Measure the EXACT content size after layout settles, and only tell main to
  // resize when it actually changed — so the panel grows/shrinks only when needed
  // instead of creeping on every keystroke or delta.
  refreshCollapseAllBtn();
  requestAnimationFrame(() => {
    const bar = document.querySelector(".composer");
    const title = document.querySelector(".titlebar");
    const att = document.getElementById("attachments");
    const attH = att && att.classList.contains("show") ? att.offsetHeight : 0;
    const threadH = threadEl.classList.contains("show")
      ? Math.min(threadEl.scrollHeight + 1, 420)
      : 0;
    // The live meeting notes and side-panel cards are their own floating
    // windows now, so they never contribute to the chat column size.
    const chatH = title.offsetHeight + threadH + attH + bar.offsetHeight + 2;

    const w = CHAT_WIDTH;
    const h = chatH;
    if (h !== lastReportedHeight || w !== lastReportedWidth) {
      lastReportedHeight = h;
      lastReportedWidth = w;
      window.lyknOverlay.resize(w, h);
    }
  });
}

function setBusy(on) {
  busy = on;
  dotEl.classList.toggle("busy", on);
  sendEl.classList.toggle("busy", on);
  sendEl.disabled = on;
}

// Type the newest step explanation instead of flashing the whole paragraph.
let stepNoteType = { timer: null, key: "", shown: "", target: "" };

function stopStepNoteTyping() {
  if (stepNoteType.timer) {
    clearTimeout(stepNoteType.timer);
    stepNoteType.timer = null;
  }
}

// Start a new turn: collapse every prior turn, append an expanded item for this
// question, and return its answer element to stream into.
function startTurn(question) {
  // A new question is pending — reset sources side data but keep live watch panel open.
  stopStatusRotation();
  stopStepNoteTyping();
  stepNoteType = { timer: null, key: "", shown: "", target: "" };
  // A new turn supersedes any parked wait from the previous one.
  pendingAgentWaiting = null;
  currentPageSource = null;
  resetSideForNewTurn();
  threadEl.querySelectorAll(".chat").forEach((c) => c.classList.add("collapsed"));

  const item = document.createElement("div");
  item.className = "chat";

  const q = document.createElement("div");
  q.className = "chat-q";
  q.setAttribute("role", "button");
  q.tabIndex = 0;
  q.innerHTML = CHEVRON_SVG;
  const qt = document.createElement("span");
  qt.className = "q-text";
  qt.textContent = question;
  q.appendChild(qt);

  const a = document.createElement("div");
  a.className = "chat-a";
  const body = document.createElement("div");
  body.className = "chat-a-body";
  body.innerHTML = thinkingHTML();
  a.appendChild(body);
  const actions = document.createElement("div");
  actions.className = "chat-a-actions";
  actions.hidden = true;
  actions.innerHTML = CHAT_COPY_BTN_HTML;
  a.appendChild(actions);

  item.appendChild(q);
  item.appendChild(a);
  threadEl.appendChild(item);
  threadEl.classList.add("show");
  currentAnswerEl = a;
  currentChatEl = item;
  currentQuestion = question || "";
  currentHasText = false;
  answerStillWorking = true;
  lastThinkingStatus = "Thinking…";
  setThinkingStatus("Thinking…");

  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
  return a;
}

function renderHistoricTurn(question, answer, collapsed) {
  const item = document.createElement("div");
  item.className = "chat" + (collapsed ? " collapsed" : "");

  const q = document.createElement("div");
  q.className = "chat-q";
  q.setAttribute("role", "button");
  q.tabIndex = 0;
  q.innerHTML = CHEVRON_SVG;
  const qt = document.createElement("span");
  qt.className = "q-text";
  qt.textContent = question;
  q.appendChild(qt);

  const a = document.createElement("div");
  a.className = "chat-a has-md";
  a.dataset.raw = String(answer || "");
  const body = document.createElement("div");
  body.className = "chat-a-body";
  body.innerHTML = renderMarkdown(answer || "");
  a.appendChild(body);
  const actions = document.createElement("div");
  actions.className = "chat-a-actions";
  actions.hidden = !String(answer || "").trim();
  actions.innerHTML = CHAT_COPY_BTN_HTML;
  a.appendChild(actions);

  item.appendChild(q);
  item.appendChild(a);
  threadEl.appendChild(item);
  return item;
}

async function persistCurrentSession() {
  if (!history.length) return;
  try {
    const firstUser = history.find((m) => m.role === "user" && String(m.content || "").trim());
    const res = await window.lyknOverlay.saveOverlaySession({
      sessionId: currentSessionId,
      messages: history,
      title: firstUser ? String(firstUser.content).trim().slice(0, 72) : undefined,
      pageSource: currentPageSource && currentPageSource.url ? currentPageSource : null,
    });
    if (res && res.sessionId) currentSessionId = res.sessionId;
  } catch (_) {}
}

function rebuildThreadFromHistory(openLast) {
  threadEl.innerHTML = "";
  let pendingQ = null;
  const pairs = [];
  for (const m of history) {
    if (m.role === "user") pendingQ = m.content;
    else if (m.role === "assistant" && pendingQ != null) {
      pairs.push({ q: pendingQ, a: m.content });
      pendingQ = null;
    }
  }
  pairs.forEach((p, i) => {
    const isLast = i === pairs.length - 1;
    renderHistoricTurn(p.q, p.a, openLast ? !isLast : true);
  });
  threadEl.classList.toggle("show", pairs.length > 0);
  reportHeight();
  // Unpaired trailing user message (in-flight agent turn) — caller may resume it.
  return pendingQ;
}

async function loadOverlaySession(session) {
  if (!session || !Array.isArray(session.messages)) return;
  history.length = 0;
  history.push(...session.messages);
  currentSessionId = session.id;
  rebuildThreadFromHistory(true);
  clearSide();
  setHistoryOpen(false);
  setMenuOpen(false);
  // Opening a chat always lands in plain chat mode — image/build stickiness
  // belongs to the session the user armed it in, not the one they open.
  setComposerMode("chat");
  // Past chats don't carry project scope today — clear so we don't leak
  // a previous project's context into an unrelated thread.
  setScopedProject(null);
  askEl.focus();
}

async function startNewMainAgentChat() {
  if (!window.lyknOverlay?.agentResetMain) return false;
  try {
    const res = await window.lyknOverlay.agentResetMain();
    if (!res?.ok) return false;
    activeAgentId = res.agentId || activeAgentId;
    applyAgentTranscript(res.history || [], res.agent || null);
    clearSide();
    setHistoryOpen(false);
    setMenuOpen(false);
    askEl.focus();
    reportHeight();
    return true;
  } catch (_) {
    return false;
  }
}

async function startNewOverlayChat() {
  // In Agent Mode, New chat resets Main (orchestrator thread) — stay armed.
  if (agentModeArmed || composerMode === "agent") {
    const ok = await startNewMainAgentChat();
    if (ok) return;
  }
  await persistCurrentSession();
  try {
    const res = await window.lyknOverlay.newOverlaySession();
    currentSessionId = (res && res.sessionId) || null;
  } catch (_) {
    currentSessionId = null;
  }
  history.length = 0;
  threadEl.innerHTML = "";
  threadEl.classList.remove("show");
  liveNotesSnapshot = {
    keyPoints: [],
    actionItems: [],
    summary: "",
    questionsToAsk: [],
    suggestions: [],
    topics: [],
  };
  clearSide();
  setHistoryOpen(false);
  // New chats always start in plain chat mode (project scope cleared unless
  // the caller re-scopes immediately after — see select-project).
  setComposerMode("chat");
  setScopedProject(null);
  askEl.focus();
  // Only place we intentionally shrink — new chat resets the bar height.
  reportHeight();
}

// Keep the last status so we can re-attach the building spinner under the
// description after each markdown rewrite (updateAnswer replaces innerHTML).
let lastThinkingStatus = "Thinking…";
let answerStillWorking = false;

function ensureBuildingUnder(status) {
  if (!currentAnswerEl || !currentHasText) return;
  const body = ensureAnswerChrome(currentAnswerEl) || currentAnswerEl;
  let wrap = body.querySelector(".building-under");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "building-under";
    wrap.innerHTML = thinkingHTML();
    body.appendChild(wrap);
  }
  const el = wrap.querySelector(".thinking-text");
  if (el) el.textContent = status || lastThinkingStatus || "Building…";
}

function clearBuildingUnder() {
  stopStatusRotation();
  const wrap = currentAnswerEl && currentAnswerEl.querySelector(".building-under");
  if (wrap) wrap.remove();
}

// Update the shimmer status label. Before any answer text arrives this drives
// the initial spinner; once the model has written a description (common in
// build mode), keep showing the same animation UNDER that description so the
// user can see LYKN is still building.
function setThinkingStatus(text) {
  if (!currentAnswerEl) return;
  const next = text || "Thinking…";
  lastThinkingStatus = next;
  maybeRotateFromStatus(next);
  // If rotation claimed this status, it already painted via applyRotatedStatus.
  if (statusRotateActive && (GENERIC_BUILD_RE.test(next) || GENERIC_THINK_RE.test(next))) {
    threadEl.scrollTop = threadEl.scrollHeight;
    return;
  }
  if (!currentHasText) {
    const el = currentAnswerEl.querySelector(".thinking-text");
    if (el) el.textContent = lastThinkingStatus;
  } else if (shouldKeepBuildingUnder()) {
    ensureBuildingUnder(lastThinkingStatus);
  }
  threadEl.scrollTop = threadEl.scrollHeight;
  // Don't resize on status text swaps — height rarely changes and it adds noise.
}

// Earlier notes stay as rendered; only the latest one writes out.
function newestStepNoteNodes(bodyEl) {
  const steps = [...bodyEl.querySelectorAll(".md-step")];
  const last = steps[steps.length - 1];
  if (!last) return null;
  const nodes = [];
  let n = last.nextElementSibling;
  while (n && !n.classList.contains("md-step") && n.tagName !== "HR") {
    nodes.push(n);
    n = n.nextElementSibling;
  }
  if (!nodes.length) return null;
  const key = `${last.getAttribute("data-agent-id") || ""}/${last.getAttribute("data-step-index") || steps.length - 1}`;
  const target = nodes
    .map((el) => el.textContent)
    .join("\n\n")
    .replace(/\s+$/, "")
    .trim();
  if (!target) return null;
  return { key, nodes, target };
}

function typeNewestStepNote(bodyEl) {
  const found = newestStepNoteNodes(bodyEl);
  if (!found) {
    stopStepNoteTyping();
    return;
  }
  const { key, nodes, target } = found;
  const htmls = nodes.map((el) => el.innerHTML);
  if (stepNoteType.key !== key || !target.startsWith(stepNoteType.shown)) {
    stopStepNoteTyping();
    stepNoteType.key = key;
    stepNoteType.shown = "";
  }
  stepNoteType.target = target;
  nodes.forEach((el, i) => {
    if (i === 0) {
      el.classList.add("md-step-note");
      el.textContent = stepNoteType.shown;
    } else {
      el.hidden = true;
    }
  });
  const finish = () => {
    nodes.forEach((el, i) => {
      el.hidden = false;
      if (htmls[i] != null) el.innerHTML = htmls[i];
      el.classList.add("md-step-note");
    });
    stepNoteType.shown = target;
    stepNoteType.timer = null;
    threadEl.scrollTop = threadEl.scrollHeight;
    reportHeight();
  };
  if (stepNoteType.shown === target) {
    finish();
    return;
  }
  const stepMs = target.length > 220 ? 12 : target.length > 80 ? 16 : 22;
  const tick = () => {
    if (stepNoteType.shown === stepNoteType.target) {
      finish();
      return;
    }
    const rest = stepNoteType.target.startsWith(stepNoteType.shown)
      ? stepNoteType.target.slice(stepNoteType.shown.length)
      : stepNoteType.target;
    const m = rest.match(/^(\s+|\S+)/);
    stepNoteType.shown =
      (stepNoteType.target.startsWith(stepNoteType.shown) ? stepNoteType.shown : "") +
      (m ? m[1] : rest);
    if (nodes[0]) nodes[0].textContent = stepNoteType.shown;
    threadEl.scrollTop = threadEl.scrollHeight;
    reportHeight();
    stepNoteType.timer = setTimeout(tick, stepMs);
  };
  stopStepNoteTyping();
  stepNoteType.timer = setTimeout(tick, stepMs);
}

function updateAnswer(text) {
  if (!currentAnswerEl) return;
  const bodyEl = ensureAnswerChrome(currentAnswerEl);
  if (!bodyEl) return;
  // Trim trailing blank lines/whitespace — with pre-wrap they'd render as empty
  // vertical space and make the panel look like it grew for no reason.
  const trimmed = (text || "").replace(/\s+$/, "");
  if (!trimmed && !currentHasText) return; // keep the spinner until real text
  currentHasText = true;
  currentAnswerEl.classList.add("has-md");
  currentAnswerEl.dataset.raw = trimmed;
  bodyEl.innerHTML = renderMarkdown(trimmed);
  const hasLiveStep = /lykn-agent-step:\/\/[^)\s]+\/live\b/i.test(trimmed);
  const shouldTypeNotes =
    /lykn-agent-step:\/\//i.test(trimmed) && (answerStillWorking || hasLiveStep);
  if (shouldTypeNotes) typeNewestStepNote(bodyEl);
  else stopStepNoteTyping();
  const actions = currentAnswerEl.querySelector(":scope > .chat-a-actions");
  if (actions) actions.hidden = !trimmed;
  // Build mode: description lands first, then the tool runs for a while with
  // no more text — put the thinking animation under the description so it's
  // obvious LYKN is still working. Regular chat drops the spinner as soon as
  // the reply text is on screen so it doesn't keep looping after the model
  // has finished saying what it was going to say.
  if (shouldKeepBuildingUnder()) ensureBuildingUnder(lastThinkingStatus);
  else if (statusRotateLane !== "build") stopStatusRotation();
  // Generated images / artifact iframes load async — resize once they settle,
  // or the bubble stays sized for text only and the preview gets clipped.
  const onMediaReady = () => {
    threadEl.scrollTop = threadEl.scrollHeight;
    reportHeight();
  };
  bodyEl.querySelectorAll(".md-img img").forEach((img) => {
    if (img.complete) return;
    img.addEventListener("load", onMediaReady, { once: true });
  });
  bodyEl.querySelectorAll(".md-artifact iframe").forEach((frame) => {
    frame.addEventListener("load", onMediaReady, { once: true });
  });
  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
}

/**
 * "Paused, waiting on you" indicator. The agent parks on sign-in walls and
 * manual steps while still watching the tab, but the turn itself finishes — so
 * the busy spinner goes away. This row keeps the same mark drawing, under a
 * label saying what it is waiting for, until the runtime says the wall cleared,
 * so a parked run never looks like a done run.
 */
let pendingAgentWaiting = null;

function clearAgentWaitingRow(answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el) return;
  el.querySelectorAll(":scope > .agent-waiting-row").forEach((n) => n.remove());
}

function renderAgentWaitingRow(answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el) return;
  clearAgentWaitingRow(el);
  if (!pendingAgentWaiting) return;
  const row = document.createElement("div");
  row.className = "agent-waiting-row";
  // Same mark and shimmer as the thinking state, just saying something else.
  row.innerHTML = thinkingHTML();
  const label = row.querySelector(".thinking-text");
  if (label) label.textContent = pendingAgentWaiting.label;
  if (pendingAgentWaiting.detail) {
    const detail = document.createElement("div");
    detail.className = "agent-waiting-detail";
    detail.textContent = pendingAgentWaiting.detail;
    row.appendChild(detail);
  }
  const actions = el.querySelector(":scope > .chat-a-actions");
  if (actions) el.insertBefore(row, actions);
  else el.appendChild(row);
  reportHeight();
}

function setAgentWaiting(p) {
  if (!p?.waiting) {
    pendingAgentWaiting = null;
    clearAgentWaitingRow();
    reportHeight();
    return;
  }
  const kind = String(p.kind || "");
  const host = String(p.host || "").trim();
  const fallback =
    kind === "signin"
      ? `Waiting for you to sign in${host ? ` to ${host}` : ""}`
      : kind === "approval"
        ? "Waiting for your go-ahead"
        : "Waiting for you";
  pendingAgentWaiting = {
    label: String(p.label || "").trim() || fallback,
    detail: String(p.detail || "").trim(),
  };
  renderAgentWaitingRow();
}

/** Choice buttons under an agent answer (e.g. complex software → artifact vs stop). */
let pendingAgentChoice = null;

function clearAgentChoiceButtons(answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el) return;
  el.querySelectorAll(":scope > .agent-choice-row").forEach((n) => n.remove());
}

function showAgentChoiceButtons(choice, answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el || !choice || !Array.isArray(choice.buttons) || !choice.buttons.length) return;
  clearAgentChoiceButtons(el);
  pendingAgentChoice = {
    agentId: choice.agentId || activeAgentId,
    choiceId: choice.choiceId || choice.id || "",
    buttons: choice.buttons,
  };
  const row = document.createElement("div");
  row.className = "agent-choice-row";
  for (const btn of choice.buttons) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "agent-choice-btn " + (btn.primary ? "primary" : "secondary");
    b.textContent = String(btn.label || btn.id || "Choose");
    b.dataset.choiceId = String(pendingAgentChoice.choiceId || "");
    b.dataset.buttonId = String(btn.id || "");
    b.addEventListener("click", () => {
      void resolveAgentChoiceClick(b.dataset.choiceId, b.dataset.buttonId, row);
    });
    row.appendChild(b);
  }
  const actions = el.querySelector(":scope > .chat-a-actions");
  if (actions) el.insertBefore(row, actions);
  else el.appendChild(row);
  reportHeight();
}

async function resolveAgentChoiceClick(choiceId, buttonId, rowEl) {
  const agentId = pendingAgentChoice?.agentId || activeAgentId;
  if (!agentId || !buttonId) return;
  if (rowEl) {
    rowEl.querySelectorAll("button").forEach((b) => {
      b.disabled = true;
    });
  }
  setBusy(true);
  setThinkingStatus(
    buttonId === "use-artifact"
      ? "Building custom artifact…"
      : buttonId === "send"
        ? "Sending…"
        : buttonId === "approve"
          ? "Continuing…"
          : buttonId === "decline"
            ? "Skipping that step…"
            : "Stopping…",
  );
  // The send run streams progress into the current turn while we await it.
  if (buttonId === "send") answerStillWorking = true;
  // Local Mode approval: the paused local task resumes (or safely skips the
  // step) and keeps streaming into this same turn.
  if (buttonId === "approve" || buttonId === "decline") answerStillWorking = true;
  try {
    const res = await window.lyknOverlay.agentChoiceResolve(
      agentId,
      choiceId,
      buttonId,
    );
    pendingAgentChoice = null;
    clearAgentChoiceButtons();
    if (res?.ok && res?.spawned && res?.agentId) {
      activeAgentId = res.agentId;
      setBusy(true);
      reportHeight();
      return;
    }
    if (res?.ok && res?.text) {
      if (!currentAnswerEl) {
        startTurn("Choice");
      }
      updateAnswer(res.text);
      const last = history[history.length - 1];
      if (!(last && last.role === "assistant" && last.content === res.text)) {
        history.push({
          role: "assistant",
          content: res.text,
          at: new Date().toISOString(),
        });
      }
    } else if (!res?.ok) {
      updateAnswer(res?.error || "Couldn't apply that choice.");
    }
    // use-artifact starts a build — stream handlers finish the turn.
    if (res?.ok && buttonId === "use-artifact" && !res?.stopped) {
      setBusy(true);
      answerStillWorking = true;
      reportHeight();
      return;
    }
    // Local Mode approval resolved — the paused task is still running; its
    // delta/done events finish the turn.
    if (res?.ok && (buttonId === "approve" || buttonId === "decline")) {
      setBusy(true);
      answerStillWorking = true;
      reportHeight();
      return;
    }
  } catch (e) {
    updateAnswer(e?.message || "Couldn't apply that choice.");
  }
  answerStillWorking = false;
  clearBuildingUnder();
  setBusy(false);
  reportHeight();
  askEl.focus();
}

const DEFAULT_ASK_PLACEHOLDER = "Ask LYKN about your screen…";
let browserActArmed = false;
// Image generation is explicit-opt-in (menu → "Create an image"), mirroring
// the web app's "+" → Generate image mode. STICKY: once armed, every send is
// an image prompt (forceImage rides along to the server, which forces GPT
// Image 2) until the user switches back to chat mode — via the composer's
// mode pill ✕, the menu toggle, or starting a new chat.
let imageGenArmed = false;
// Build mode (menu → "Build mode"): sends ask LYKN to CODE the thing out — a
// live React artifact (landing page, dashboard, mini-tool…) rendered inline,
// same pipeline as the web app's Claude-style artifacts. Sticky like image
// mode.
let buildModeArmed = false;
let researchModeArmed = false;
let translateModeArmed = false;
let transcribeModeArmed = false;
let agentModeArmed = false;
/** Active Glass Agent Mode agent id (main owns the registry). */
let activeAgentId = null;
/** Partial stream text for the active agent turn. */
let agentStreamingText = "";
/** Live system+mic capture for Transcribe mode (declared early for mode sync). */
let listening = false;
/** Prevent setComposerMode ↔ start/stopListen feedback loops. */
let syncingTranscribeMode = false;

// ── Composer mode (chat / image / build / agent / research / translate / transcribe)
// One switch owns the armed flags, the placeholder, the composer pill, and
// the drawer badges, so every entry point (menu toggle, pill ✕, new chat,
// Escape) stays consistent.
const MODE_ICON_SVG = {
  image:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
  build:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  agent:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
  research:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  translate:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  transcribe:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a9 9 0 0 1 18 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>',
};
const COMPOSER_MODES = {
  chat: { placeholder: DEFAULT_ASK_PLACEHOLDER, title: "" },
  image: {
    placeholder: "Describe the image to create, then Send…",
    title: "Image mode — click to exit",
  },
  build: {
    placeholder: "Describe what to build, then Send…",
    title: "Build mode — click to exit",
  },
  agent: {
    placeholder: "Agent goal — research, build, browse, or monitor…",
    title: "Agent mode — click to exit",
  },
  research: {
    placeholder: "Deep research a topic — multi-source analysis…",
    title: "Deep research — click to exit",
  },
  translate: {
    placeholder: "Translate your screen, or type text…",
    title: "Translate mode — click to exit",
  },
  transcribe: {
    placeholder: "Listening to system + mic — ask about what's being said…",
    title: "Transcribe — click to exit",
  },
};
let composerMode = "chat";
const modeBadgeEl = document.getElementById("mode-badge");
const modeBadgeIconEl = document.getElementById("mode-badge-icon");
const projectPillEl = document.getElementById("project-pill");
const projectPillLabelEl = document.getElementById("project-pill-label");
const translateLangPillEl = document.getElementById("translate-lang-pill");
const translateLangBtnEl = document.getElementById("translate-lang-btn");
const translateLangMenuEl = document.getElementById("translate-lang-menu");
const translateLangLabelEl = document.getElementById("translate-lang-label");
const TRANSLATE_LANG_KEY = "lykn.glass.translateLang";
const TRANSLATE_LANGS = [
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Japanese",
  "Korean",
  "Arabic",
  "Hindi",
  "Russian",
  "Polish",
  "Turkish",
  "Vietnamese",
  "Thai",
  "Swedish",
  "Norwegian",
  "Danish",
  "Finnish",
  "Greek",
  "Hebrew",
  "English",
];
let translateTargetLang = "Spanish";
/** Explicit Glass project scope from the menu Projects picker (null = general). */
let scopedProject = null; // { id, name } | null

function getTranslateTargetLang() {
  return translateTargetLang || "Spanish";
}

function setTranslateLangMenuOpen(open) {
  if (!translateLangPillEl || !translateLangBtnEl) return;
  translateLangPillEl.classList.toggle("open", !!open);
  translateLangBtnEl.setAttribute("aria-expanded", open ? "true" : "false");
  // In-window list stays hidden — the real list is a detached vibrancy card
  // (same pattern as the three-dot menu), so the chat bar never grows/moves.
  if (translateLangMenuEl) translateLangMenuEl.hidden = true;
  try {
    if (open && translateLangPillEl) {
      const r = translateLangPillEl.getBoundingClientRect();
      window.lyknOverlay.setLangPicker(true, {
        left: r.left,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      });
    } else {
      window.lyknOverlay.setLangPicker(false);
    }
  } catch (_) {}
}

window.__lyknLangPickerState = () => ({
  languages: TRANSLATE_LANGS.slice(),
  active: getTranslateTargetLang(),
});

if (window.lyknOverlay?.onLangPickerSelect) {
  window.lyknOverlay.onLangPickerSelect((p) => {
    const lang = String(p?.lang || "").trim();
    if (lang) setTranslateTargetLang(lang);
    setTranslateLangMenuOpen(false);
    askEl.focus();
  });
}
if (window.lyknOverlay?.onLangPickerVisible) {
  window.lyknOverlay.onLangPickerVisible((visible) => {
    if (!translateLangPillEl || !translateLangBtnEl) return;
    translateLangPillEl.classList.toggle("open", !!visible);
    translateLangBtnEl.setAttribute("aria-expanded", visible ? "true" : "false");
  });
}

function renderTranslateLangMenu() {
  if (!translateLangMenuEl) return;
  const cur = getTranslateTargetLang();
  translateLangMenuEl.innerHTML = TRANSLATE_LANGS.map(
    (lang) =>
      `<button type="button" class="lang-option" role="option" data-lang="${lang.replace(/"/g, "&quot;")}" aria-selected="${lang === cur ? "true" : "false"}">${lang}</button>`,
  ).join("");
}

function setTranslateTargetLang(lang) {
  const next = TRANSLATE_LANGS.includes(lang) ? lang : "Spanish";
  translateTargetLang = next;
  if (translateLangLabelEl) translateLangLabelEl.textContent = next;
  try {
    localStorage.setItem(TRANSLATE_LANG_KEY, next);
  } catch (_) {}
  renderTranslateLangMenu();
  if (composerMode === "translate") {
    askEl.placeholder = `Translate screen to ${next}, or type text…`;
  }
}

function loadTranslateTargetLang() {
  try {
    const saved = String(localStorage.getItem(TRANSLATE_LANG_KEY) || "").trim();
    if (TRANSLATE_LANGS.includes(saved)) translateTargetLang = saved;
  } catch (_) {}
  if (translateLangLabelEl) translateLangLabelEl.textContent = translateTargetLang;
  renderTranslateLangMenu();
}

loadTranslateTargetLang();
if (translateLangBtnEl) {
  translateLangBtnEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = !translateLangPillEl?.classList.contains("open");
    setTranslateLangMenuOpen(open);
  });
}
if (translateLangMenuEl) {
  translateLangMenuEl.addEventListener("click", (e) => {
    const opt = e.target.closest(".lang-option");
    if (!opt) return;
    e.preventDefault();
    e.stopPropagation();
    setTranslateTargetLang(opt.getAttribute("data-lang") || "Spanish");
    setTranslateLangMenuOpen(false);
    askEl.focus();
  });
}
document.addEventListener("click", (e) => {
  if (!translateLangPillEl || translateLangPillEl.hidden) return;
  if (translateLangPillEl.contains(e.target)) return;
  setTranslateLangMenuOpen(false);
});

const COPY_BTN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16V4a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_BTN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CHAT_COPY_BTN_HTML =
  `<button type="button" class="chat-copy" title="Copy answer" aria-label="Copy answer">${COPY_BTN_SVG}</button>`;

function renderModeBadge(id, on) {
  const el = document.getElementById(id);
  if (el) el.textContent = on ? "On" : "Off";
}

function renderProjectPill() {
  if (!projectPillEl) return;
  const name = scopedProject?.name ? String(scopedProject.name).trim() : "";
  projectPillEl.hidden = !name;
  if (projectPillLabelEl) {
    projectPillLabelEl.textContent = name ? name.slice(0, 28) : "Project";
  }
  projectPillEl.title = name ? `Scoped to ${name} — click to clear` : "Clear project scope";
  reportHeight();
}

function setScopedProject(next) {
  if (next && next.id) {
    scopedProject = {
      id: String(next.id).trim(),
      name: String(next.name || "Project").trim().slice(0, 120) || "Project",
    };
  } else {
    scopedProject = null;
  }
  renderProjectPill();
}

function setComposerMode(mode) {
  const prev = composerMode;
  composerMode = COMPOSER_MODES[mode] ? mode : "chat";
  imageGenArmed = composerMode === "image";
  buildModeArmed = composerMode === "build";
  agentModeArmed = composerMode === "agent";
  researchModeArmed = composerMode === "research";
  translateModeArmed = composerMode === "translate";
  transcribeModeArmed = composerMode === "transcribe";
  askEl.placeholder =
    composerMode === "translate"
      ? `Translate screen to ${getTranslateTargetLang()}, or type text…`
      : COMPOSER_MODES[composerMode].placeholder;
  if (modeBadgeEl) {
    const active = composerMode !== "chat";
    modeBadgeEl.hidden = !active;
    if (active) {
      const meta = COMPOSER_MODES[composerMode] || {};
      modeBadgeEl.title = meta.title || "Back to chat";
      modeBadgeEl.setAttribute("aria-label", meta.title || "Back to chat");
      if (modeBadgeIconEl) {
        modeBadgeIconEl.innerHTML = MODE_ICON_SVG[composerMode] || "";
      }
    }
  }
  if (translateLangPillEl) {
    translateLangPillEl.hidden = composerMode !== "translate";
    if (composerMode !== "translate") {
      try {
        window.lyknOverlay.setLangPicker(false);
      } catch (_) {}
      translateLangPillEl.classList.remove("open");
      if (translateLangBtnEl) translateLangBtnEl.setAttribute("aria-expanded", "false");
    }
  }
  renderModeBadge("image-gen-state", composerMode === "image");
  renderModeBadge("build-state", composerMode === "build");
  renderModeBadge("agent-state", composerMode === "agent");
  renderModeBadge("research-state", composerMode === "research");
  renderModeBadge("translate-state", composerMode === "translate");
  renderModeBadge("transcribe-state", composerMode === "transcribe" || listening);
  reportHeight();

  // Agent Mode: open Cursor-style agent sidebar + browser stage; leave → hide.
  if (composerMode === "agent" && prev !== "agent") {
    void enterAgentMode();
  } else if (prev === "agent" && composerMode !== "agent") {
    void leaveAgentMode();
  } else {
  }

  // Transcribe mode = live system+mic capture (same pipeline as former
  // "Live meeting notes"). Arm → start listening; leave → stop.
  if (!syncingTranscribeMode) {
    if (composerMode === "transcribe" && prev !== "transcribe") {
      void ensureTranscribeListening();
    } else if (prev === "transcribe" && composerMode !== "transcribe") {
      if (listening) stopListen();
    }
  }
}

async function enterAgentMode() {
  try {
    const res = await window.lyknOverlay.agentModeSet(true);
    if (res?.activeAgentId) activeAgentId = res.activeAgentId;
    const snap = await window.lyknOverlay.agentHistory(activeAgentId);
    applyAgentTranscript(snap?.history || [], snap?.agent || snap || null);
  } catch (_) {}
}

async function leaveAgentMode() {
  try {
    await window.lyknOverlay.agentModeSet(false);
  } catch (_) {}
}

/**
 * Paint an agent's transcript in Glass. If the agent is mid-run, reopen the
 * pending user turn with spinner / partial stream text (history alone drops
 * unpaired user messages).
 */
function applyAgentTranscript(nextHistory, agentMeta) {
  history.length = 0;
  if (Array.isArray(nextHistory)) history.push(...nextHistory);
  const pendingQ = rebuildThreadFromHistory(true);
  currentAnswerEl = null;
  currentChatEl = null;
  streamingText = "";
  agentStreamingText = "";

  const busy = !!(agentMeta && (agentMeta.busy || agentMeta.status === "running"));
  const partial = String(
    (agentMeta && (agentMeta.partialText || agentMeta.partial_text)) || "",
  ).trim();
  const step = String((agentMeta && agentMeta.step) || "").trim() || "Thinking…";

  if (busy || pendingQ) {
    const q =
      pendingQ ||
      String((agentMeta && agentMeta.title) || "").trim() ||
      "Working…";
    startTurn(q);
    // history already contains the user message from the registry — don't push again
    setBusy(true);
    answerStillWorking = true;
    if (partial) {
      agentStreamingText = partial;
      updateAnswer(partial);
      if (answerStillWorking) setThinkingStatus(step);
    } else {
      setThinkingStatus(step);
    }
  } else {
    setBusy(false);
    answerStillWorking = false;
  }
}

async function ensureTranscribeListening() {
  if (listening) {
    renderModeBadge("transcribe-state", true);
    return;
  }
  await startListen();
  if (!listening) {
    // Permission / capture failed — drop back to chat.
    syncingTranscribeMode = true;
    try {
      setComposerMode("chat");
    } finally {
      syncingTranscribeMode = false;
    }
  }
}

/** Ensure answer DOM has a stable body + Copy footer (survives markdown rewrites). */
function ensureAnswerChrome(answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el) return null;
  let body = el.querySelector(":scope > .chat-a-body");
  let actions = el.querySelector(":scope > .chat-a-actions");
  if (!body) {
    body = document.createElement("div");
    body.className = "chat-a-body";
    const keep = [];
    while (el.firstChild) keep.push(el.removeChild(el.firstChild));
    for (const node of keep) {
      if (node.classList && node.classList.contains("chat-a-actions")) {
        actions = node;
      } else {
        body.appendChild(node);
      }
    }
    el.appendChild(body);
  }
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "chat-a-actions";
    actions.hidden = true;
    actions.innerHTML = CHAT_COPY_BTN_HTML;
    el.appendChild(actions);
  }
  return body;
}

/** Strip Glass UI chrome and map display-only markdown nodes to semantic tags. */
function htmlForClipboardFromBody(body) {
  if (!body) return "";
  try {
    const clone = body.cloneNode(true);
    clone
      .querySelectorAll(
        "button, iframe, script, style, .md-artifact-actions, .md-artifact-code, .md-step-chevron, .md-step-kind, .md-vault-open",
      )
      .forEach((n) => n.remove());
    clone.querySelectorAll(".md-h").forEach((el) => {
      const h = document.createElement("h2");
      h.innerHTML = el.innerHTML;
      el.replaceWith(h);
    });
    return clone.innerHTML || "";
  } catch (_) {
    return String(body.innerHTML || "");
  }
}

async function copyAnswerText(btn) {
  const answerEl = btn?.closest?.(".chat-a");
  if (!answerEl) return;
  const body = answerEl.querySelector(":scope > .chat-a-body");
  // Prefer rendered body so paste targets get real headings/bold, not ## / **.
  // Fall back to converting dataset.raw markdown when the body isn't ready.
  let plain = String(body?.innerText || body?.textContent || "").trim();
  let html = "";
  const fromBody = htmlForClipboardFromBody(body);
  if (fromBody.trim()) {
    html = wrapClipboardHtml(fromBody);
  } else {
    const raw = String(answerEl.dataset.raw || "").trim();
    if (raw) {
      const rendered = renderMarkdown(raw);
      const tmp = document.createElement("div");
      tmp.innerHTML = rendered;
      html = wrapClipboardHtml(htmlForClipboardFromBody(tmp) || rendered);
      if (!plain) {
        plain = String(tmp.innerText || tmp.textContent || "").trim() || raw;
      }
    }
  }
  if (!plain && !html) return;
  const ok = await writeRichClipboard(plain, html);
  if (!ok) return;
  btn.classList.add("copied");
  btn.innerHTML = CHECK_BTN_SVG;
  btn.title = "Copied";
  btn.setAttribute("aria-label", "Copied");
}

/** Selected text from the dark glass UI — paste targets get black, not white. */
function selectionPlainText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  return String(sel.toString());
}

/** Clone the current selection as HTML so bold/headings survive paste. */
function selectionRichHtml() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  try {
    const container = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    container
      .querySelectorAll(
        "button, iframe, script, style, .md-artifact-actions, .md-artifact-code, .md-step-chevron, .md-step-kind, .md-vault-open",
      )
      .forEach((n) => n.remove());
    container.querySelectorAll(".md-h").forEach((el) => {
      const h = document.createElement("h2");
      h.innerHTML = el.innerHTML;
      el.replaceWith(h);
    });
    return container.innerHTML || "";
  } catch (_) {
    return "";
  }
}

function wrapClipboardHtml(fragmentHtml) {
  const inner = String(fragmentHtml || "").trim();
  if (!inner) return "";
  return (
    `<meta charset="utf-8">` +
    `<div style="color:#000000; -webkit-text-fill-color:#000000;">${inner}</div>`
  );
}

function blackHtmlFromPlain(text) {
  const escaped = escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>");
  return wrapClipboardHtml(escaped);
}

async function writeRichClipboard(plain, html) {
  const text = String(plain || "").trim();
  const rich = String(html || "").trim();
  if (!text && !rich) return false;
  if (rich && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text || ""], { type: "text/plain" }),
          "text/html": new Blob([rich], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch (_) {
      /* fall through */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch (_) {
      return false;
    }
  }
}

function writeBlackTransferData(transfer, text, htmlFragment) {
  if (!transfer || !text) return false;
  transfer.setData("text/plain", text);
  const rich = htmlFragment
    ? wrapClipboardHtml(htmlFragment)
    : blackHtmlFromPlain(text);
  transfer.setData("text/html", rich);
  return true;
}

// Select-to-copy / drag-copy keeps the overlay's light text color in HTML
// clipboard data, so paste into Docs/Word/email looks invisible. Rewrite with
// black text while preserving semantic tags (strong, headings, lists).
document.addEventListener("copy", (e) => {
  const text = selectionPlainText();
  if (!text || !e.clipboardData) return;
  e.preventDefault();
  writeBlackTransferData(e.clipboardData, text, selectionRichHtml());
});

document.addEventListener("dragstart", (e) => {
  const text = selectionPlainText();
  if (!text || !e.dataTransfer) return;
  writeBlackTransferData(e.dataTransfer, text, selectionRichHtml());
});

// Mode icon in the titlebar — click exits back to chat.
if (modeBadgeEl) {
  modeBadgeEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setComposerMode("chat");
    askEl.focus();
  });
}
if (projectPillEl) {
  projectPillEl.addEventListener("click", () => {
    setScopedProject(null);
    askEl.focus();
  });
}
let pendingBrowserPlan = null;
let executingBrowser = false;

const browserActEl = document.getElementById("browser-act");
const browserActStepsEl = document.getElementById("browser-act-steps");
const browserActRunEl = document.getElementById("browser-act-run");
const browserActCancelEl = document.getElementById("browser-act-cancel");

function formatBrowserStep(action) {
  const label = action.label || action.selector || "element";
  if (action.type === "click") return `Click “${label}”`;
  if (action.type === "type") {
    const v = String(action.value || "").slice(0, 48);
    return `Type “${v}” into “${label}”`;
  }
  if (action.type === "press") {
    const base = String(label).replace(/ — submit$/i, "");
    return `Press Enter to submit “${base}”`;
  }
  if (action.type === "scroll") {
    const d = Number(action.delta) || 400;
    return d >= 0 ? "Scroll down" : "Scroll up";
  }
  return label;
}

function browserActErrorMessage(plan) {
  const code = plan && plan.error;
  const msg = (plan && plan.message) || "";
  if (code === "apple_events_disabled") {
    return (
      "Browser control needs **Allow JavaScript from Apple Events** enabled in your browser " +
      "(Chrome: View → Developer). Then try again."
    );
  }
  if (code === "needs_extension") {
    return (
      plan?.message ||
      "Install **Chrome Live Feed** so LYKN can read your active tab. Browser click-control is macOS-only for now — ask about what's on screen instead."
    );
  }
  if (code === "control_mac_only") {
    return (
      plan?.message ||
      "Clicking and typing in the browser is macOS-only for now. LYKN can still read your tab via Chrome Live Feed — ask about the page or what's on screen."
    );
  }
  if (code === "new_tab") {
    return (
      plan?.message ||
      "Navigate to a real website first (e.g. youtube.com). Blank new-tab pages can't be controlled."
    );
  }
  if (code === "no_browser") {
    return (
      plan?.message ||
      "No browser tab found. Open an https:// page in Chrome (not a blank new-tab page), then try again."
    );
  }
  if (code === "no_auth") return "Sign in to LYKN in the main app to use browser control.";
  if (code === "no_actions") {
    return (plan && plan.explanation) || "Could not plan any safe actions for this page.";
  }
  return msg || "Could not plan browser actions.";
}

function hideBrowserActPanel() {
  pendingBrowserPlan = null;
  if (browserActEl) browserActEl.hidden = true;
  composerEl.classList.remove("browser-act-open");
  reportHeight();
}

function showBrowserActPanel(plan) {
  if (!browserActEl || !browserActStepsEl || !plan) return;
  browserActStepsEl.innerHTML = "";
  const actions = plan.actions || [];
  const adaptive =
    plan.adaptivePreview || (!actions.length && plan.intent);
  if (adaptive) {
    const steps = String(plan.taskPlan || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (steps.length) {
      for (const step of steps) {
        const li = document.createElement("li");
        li.textContent = step.replace(/^\d+\.\s*/, "");
        browserActStepsEl.appendChild(li);
      }
    } else {
      const li = document.createElement("li");
      li.textContent = "Reads your screen, plans steps like chat, then executes one at a time";
      browserActStepsEl.appendChild(li);
    }
  } else if (actions.length) {
    for (const action of actions) {
      const li = document.createElement("li");
      li.textContent = formatBrowserStep(action);
      browserActStepsEl.appendChild(li);
    }
  } else {
    const li = document.createElement("li");
    li.textContent =
      "Reads your screen, picks one step, clicks, waits for the page to change, then re-reads";
    browserActStepsEl.appendChild(li);
  }
  browserActEl.hidden = false;
  composerEl.classList.add("browser-act-open");
  if (browserActRunEl) {
    browserActRunEl.disabled = false;
    browserActRunEl.textContent = "Run";
  }
  reportHeight();
}

function setBrowserActRunning(running) {
  if (!browserActEl || !browserActRunEl) return;
  browserActEl.hidden = false;
  composerEl.classList.add("browser-act-open");
  browserActRunEl.disabled = !!running;
  browserActRunEl.textContent = running ? "Running…" : "Run";
  reportHeight();
}

// Significant / irreversible actions that warrant an explicit confirmation
// before LYKN acts (money, deletion, sending/posting, account changes). Normal
// tasks run proactively without a preview gate.
function browserTaskIsSerious(goal, plan) {
  const hay = `${String(goal || "")}\n${String(plan?.taskPlan || "")}`.toLowerCase();
  return /\b(buy|purchase|order|checkout|check out|pay|payment|add to cart|place (an? )?order|subscribe|unsubscribe|delete|remove|erase|wipe|send (an? )?(email|message|dm|text|invite)|post|publish|tweet|submit (the |an? )?(application|form|payment|order|request)|transfer|withdraw|deposit|book (a |the )?(flight|hotel|ticket|room)|reserve|sign (a |the )?(contract|document|lease|up)|confirm (order|purchase|payment|booking)|delete (my )?account|log ?out|sign out|change (my )?(password|email|address|settings|plan)|apply for|cancel (my |the )?(order|subscription|account|booking|plan))\b/.test(
    hay,
  );
}

async function runBrowserAct(intent) {
  const goal = String(intent || "").trim();
  if (!goal || busy || executingBrowser) return;
  browserActArmed = false;
  // Restore the placeholder for whatever composer mode is armed (image/build
  // stay sticky through a browser-act detour).
  askEl.placeholder = COMPOSER_MODES[composerMode].placeholder;
  askEl.value = "";
  askEl.style.height = "48px";
  setBusy(true);
  startTurn(goal);
  hideBrowserActPanel();
  history.push({ role: "user", content: goal, at: new Date().toISOString() });
  setThinkingStatus("Scanning page…");
  try {
    const plan = await window.lyknOverlay.browserPlan(goal, history.slice(-8));
    if (!plan || !plan.ok) {
      currentHasText = true;
      updateAnswer(browserActErrorMessage(plan || {}));
      setBusy(false);
      askEl.focus();
      return;
    }
    pendingBrowserPlan = {
      ...plan,
      appName: plan.appName || plan.browser || "",
      intent: goal,
      taskPlan: plan.taskPlan || "",
      plannedAnswer: plan.plannedAnswer || "",
    };
    currentHasText = true;

    // Only gate on confirmation for significant/irreversible actions. Otherwise
    // be proactive and execute right away — no plan preview, no Run button.
    if (browserTaskIsSerious(goal, plan)) {
      showBrowserActPanel({ ...plan, intent: goal });
      updateAnswer(
        (plan.explanation || "Here's what I'll do.") +
          (plan.taskPlan ? `\n\n**Plan:**\n${plan.taskPlan}` : "") +
          "\n\n⚠️ This is a significant action. **Click Run to confirm**, or refine your request.",
      );
      setBusy(false);
      askEl.focus();
      return;
    }

    await executeBrowserAct({ auto: true });
  } catch (_) {
    currentHasText = true;
    updateAnswer("Could not plan browser actions.");
    setBusy(false);
    askEl.focus();
  }
}

async function executeBrowserAct({ auto = false } = {}) {
  const plan = pendingBrowserPlan;
  if (!plan || executingBrowser) return;
  executingBrowser = true;
  const actions = Array.isArray(plan.actions) ? plan.actions.slice() : [];
  const appName = plan.appName || plan.browser || "";
  const pageUrl = plan.url;
  const intent = plan.intent || "";
  if (!actions.length && !intent) {
    currentHasText = true;
    updateAnswer("No planned steps to run. Try Control this page again.");
    executingBrowser = false;
    setBusy(false);
    return;
  }
  // In auto mode we don't show the plan/Run panel — just stream progress inline.
  if (!auto) setBrowserActRunning(true);
  setBusy(true);
  setThinkingStatus(intent ? "Working on it…" : "Running in browser…");
  currentHasText = true;
  updateAnswer(intent ? "Working on it… (clicks pass through to Chrome)" : "Running browser actions…");
  const stopProgress =
    typeof window.lyknOverlay.onBrowserProgress === "function"
      ? window.lyknOverlay.onBrowserProgress(({ status }) => {
          if (!status) return;
          setThinkingStatus(status);
          updateAnswer(`**${status}**`);
        })
      : null;
  try {
    const result = await window.lyknOverlay.browserExecute({
      actions,
      appName,
      url: pageUrl,
      intent,
      taskPlan: plan.taskPlan || "",
      plannedAnswer: plan.plannedAnswer || "",
      conversationHistory: history.slice(-8),
      holoMessages: plan.holoMessages || null,
    });
    const summary = result?.ok
      ? result?.message || result?.explanation || "Done. Completed the task in your browser."
      : result?.message ||
        (result?.error === "no_actions"
          ? "No actions reached the browser."
          : result?.error === "no_browser"
            ? "Could not find the browser to control."
            : "Some actions failed.");
    updateAnswer(summary);
    history.push({
      role: "assistant",
      content: summary,
      at: new Date().toISOString(),
    });
    void persistCurrentSession();
    // Proactively save a summary of what was done to the user's vault.
    if (result?.ok && intent) {
      void saveBrowserTaskToVault({ intent, summary, result, pageUrl });
    }
  } catch (_) {
    updateAnswer("Failed to run browser actions.");
  } finally {
    if (typeof stopProgress === "function") stopProgress();
    executingBrowser = false;
    pendingBrowserPlan = null;
  }
  hideBrowserActPanel();
  setBusy(false);
  askEl.focus();
}

// Save a concise record of a finished browser task to the user's vault, then
// append a small confirmation line to the on-screen summary. Best-effort.
// Saved as a formatted task note (source=browser_task) — not a Quick Note.
async function saveBrowserTaskToVault({ intent, summary, result, pageUrl }) {
  if (typeof window.lyknOverlay.saveVaultNote !== "function") return;
  try {
    const steps = Array.isArray(result?.results)
      ? result.results
          .filter((r) => r && (r.label || r.type))
          .map((r) => `- ${r.ok ? "✓" : "✗"} ${String(r.label || r.type).slice(0, 120)}`)
      : [];
    const title = String(intent || "Browser task").trim().slice(0, 120) || "Browser task";
    const content = [
      `# ${title}`,
      "",
      summary ? String(summary).trim() : "",
      steps.length ? ["", "## Steps", "", ...steps].join("\n") : "",
      pageUrl ? ["", "## Page", "", pageUrl].join("\n") : "",
      "",
      `Completed: ${new Date().toLocaleString()}`,
    ]
      .filter((line) => line !== "")
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const saved = await window.lyknOverlay.saveVaultNote({
      title: title.slice(0, 120),
      content,
      tags: ["lykn-overlay", "browser-task"],
      folder: "Tasks",
      source: "browser_task",
    });
    if (saved?.ok) {
      updateAnswer(`${summary}\n\n_Saved a summary to your vault._`);
    }
  } catch (_) {
    /* vault save is best-effort */
  }
}

function looksLikeWatchRule(text) {
  const t = String(text || "").trim();
  return (
    /^(tell me|let me know|notify me|alert me|warn me|ping me)\s+when\s+/i.test(t) ||
    /^watch\s+(for|out for)\s+/i.test(t) ||
    /^(alert|notify)\s+(me\s+)?when\s+/i.test(t) ||
    /^let me know if\s+/i.test(t)
  );
}

function looksLikeClearWatchRules(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    /\b(clear|stop|cancel|remove|delete)\b.*\b(watch rules?|alerts?|notifications?)\b/.test(t) ||
    /^stop watching for\b/.test(t) ||
    /^clear watch\b/.test(t)
  );
}

async function registerWatchRule(q) {
  setBusy(true);
  startTurn(q);
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  try {
    const res = await window.lyknOverlay.addLiveWatchRule(q);
    if (!res?.ok) {
      const msg =
        res?.error === "watch_off"
          ? "Turn on **Live screen watch** first (menu), then set alerts."
          : "Couldn't add that watch rule. Try rephrasing.";
      updateAnswer(msg);
      history.push({ role: "assistant", content: msg, at: new Date().toISOString() });
      setBusy(false);
      askEl.focus();
      return;
    }
    const rule = res.rule || q;
    if (Array.isArray(res.rules)) watchActiveRules = res.rules.slice();
    const msg = `Got it. I'll alert you when **${rule}**.`;
    updateAnswer(msg);
    history.push({ role: "assistant", content: msg, at: new Date().toISOString() });
    appendWatchCommentary(`Alert set: ${rule}`, { system: true });
    void persistCurrentSession();
  } catch (_) {
    updateAnswer("Couldn't set that watch alert.");
    history.push({
      role: "assistant",
      content: "Couldn't set that watch alert.",
      at: new Date().toISOString(),
    });
  }
  setBusy(false);
  askEl.focus();
}

async function clearWatchRules(q) {
  setBusy(true);
  startTurn(q || "Clear watch alerts");
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  try {
    await window.lyknOverlay.clearLiveWatchRules();
    watchActiveRules = [];
    const msg = "Cleared all watch alerts.";
    updateAnswer(msg);
    history.push({ role: "assistant", content: msg, at: new Date().toISOString() });
    appendWatchCommentary("All watch alerts cleared.", { system: true });
    void persistCurrentSession();
  } catch (_) {
    updateAnswer("Couldn't clear watch alerts.");
  }
  setBusy(false);
  askEl.focus();
}

function ask() {
  const qRaw = askEl.value.trim();
  if (browserActArmed) {
    if (!qRaw || busy || executingBrowser) return;
    void runBrowserAct(qRaw);
    return;
  }
  // Agent Mode: per-agent streams (parallel) — never share lykn:ask abort.
  if (agentModeArmed) {
    if (!qRaw && attachments.length === 0) return;
    if (busy) return;
    void askAgent(qRaw);
    return;
  }
  if (busy) return;
  // Image mode armed (menu → "Create an image"): this send is an image
  // prompt — skip the watch/save/voice shortcut heuristics and route it to
  // the streamed chat with forceImage so the server forces GPT Image 2.
  // Attachment-only sends count too ("remix this picture" with no caption).
  const imageAsk = imageGenArmed && (!!qRaw || attachments.length > 0);
  // Build mode armed (menu → "Build mode"): this send is a build brief —
  // route it straight to the streamed chat with buildMode so the server
  // forces the React artifact builder (Claude-style coded artifact).
  const buildAsk = !imageAsk && buildModeArmed && (!!qRaw || attachments.length > 0);
  const researchAsk = !imageAsk && !buildAsk && researchModeArmed && !!qRaw;
  // Translate mode: empty send = translate what's on screen into the target lang.
  const translateAsk = !imageAsk && !buildAsk && !researchAsk && translateModeArmed;
  if (!qRaw && attachments.length === 0 && !translateAsk) return;
  const q =
    qRaw ||
    (translateAsk && attachments.length === 0
      ? `Translate what's on my screen into ${getTranslateTargetLang()}`
      : "");
  // Modes are STICKY — they stay armed across sends (follow-up edits are the
  // normal flow: "same but darker", "now add a header…"). The user leaves a
  // mode via the composer pill's ✕, the menu toggle, or a new chat.
  if (!imageAsk && !buildAsk && !researchAsk && !translateAsk) {
    // Live watch alerts — "tell me when an enemy is near", "watch for stock drop", etc.
    if (q && attachments.length === 0 && looksLikeClearWatchRules(q)) {
      askEl.value = "";
      askEl.style.height = "52px";
      void clearWatchRules(q);
      return;
    }
    if (q && attachments.length === 0 && looksLikeWatchRule(q)) {
      askEl.value = "";
      askEl.style.height = "52px";
      void registerWatchRule(q);
      return;
    }
    // Voice mode: route typed prompts/links into the LIVE voice session instead
    // of the streamed chat, so the user can talk to the voice agent by text too
    // (paste a link for it to fetch/save, type a question while muted, etc.).
    if (voiceActive || voiceStarting) {
      if (sendTextToVoice(q, attachments.slice())) {
        askEl.value = "";
        askEl.style.height = "52px";
        clearAttachments();
      }
      return;
    }
  }
  askEl.value = "";
  askEl.style.height = "52px";
  setBusy(true);
  const sentAttachments = attachments.slice();
  // Clear chips before startTurn so the forced shrink after collapse doesn't
  // leave attachment-row height as empty space above the bar.
  attachments.length = 0;
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.remove("show");
  const label =
    q || (sentAttachments.length ? `Sent ${sentAttachments.length} attachment(s)` : "");
  startTurn(label);
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  const askOpts = {
    ...(imageAsk ? { forceImage: true } : {}),
    ...(buildAsk ? { buildMode: true } : {}),
    ...(researchAsk ? { deepResearch: true } : {}),
    ...(translateAsk
      ? { translateMode: true, translateTargetLang: getTranslateTargetLang() }
      : {}),
    ...(scopedProject?.id
      ? { scopedProjectId: scopedProject.id, scopedProjectName: scopedProject.name }
      : {}),
  };
  window.lyknOverlay.ask(
    q,
    history,
    sentAttachments,
    Object.keys(askOpts).length ? askOpts : undefined,
  );
}

async function ensureActiveAgentId(goal) {
  try {
    const list = await window.lyknOverlay.agentList();
    const agents = Array.isArray(list?.agents) ? list.agents : [];
    const ids = new Set(agents.map((a) => a.id));
    if (activeAgentId && ids.has(activeAgentId)) return activeAgentId;
    if (list?.activeAgentId && ids.has(list.activeAgentId)) {
      activeAgentId = list.activeAgentId;
      return activeAgentId;
    }
    if (agents[0]?.id) {
      activeAgentId = agents[0].id;
      return activeAgentId;
    }
  } catch (_) {}
  try {
    const created = await window.lyknOverlay.agentCreate({ goal: goal || "New agent" });
    if (created?.agentId) {
      activeAgentId = created.agentId;
      return activeAgentId;
    }
  } catch (_) {}
  return null;
}

async function askAgent(qRaw) {
  const q = String(qRaw || "").trim();
  const sentAttachments = attachments.slice();
  askEl.value = "";
  askEl.style.height = "52px";
  attachments.length = 0;
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.remove("show");
  setBusy(true);
  const label = q || (sentAttachments.length ? `Sent ${sentAttachments.length} attachment(s)` : "");
  startTurn(label);
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  // Pin the agent id for this send — user may switch agents while we await.
  let sendAgentId = null;
  try {
    sendAgentId = await ensureActiveAgentId(q);
    let res = await window.lyknOverlay.agentSend(sendAgentId, q, sentAttachments);
    // Stale id after restart/close — recreate once and retry.
    if (!res?.ok && res?.error === "not_found") {
      activeAgentId = null;
      sendAgentId = await ensureActiveAgentId(q);
      res = await window.lyknOverlay.agentSend(sendAgentId, q, sentAttachments);
    }
    if (res?.agentId) sendAgentId = res.agentId;
    if (res?.ok && res?.spawned && res?.agentId) {
      // Main spawned a worker and switched Glass to it — stream handlers take over.
      activeAgentId = res.agentId;
      setBusy(true);
      reportHeight();
      return;
    }
    // Background finish must not clobber whichever agent is now active in Glass.
    if (activeAgentId && sendAgentId && activeAgentId !== sendAgentId) {
      // Still clear THIS send's composer busy if we left the spinner armed locally.
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
      return;
    }
    if (res?.agentId) activeAgentId = res.agentId;
    if (!res?.ok && res?.error && res.error !== "superseded") {
      updateAnswer(res.error === "not_found" ? "No agent available — try Agent mode again." : res.error);
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
    } else if (res?.ok && res?.skill === "delegate" && res?.text) {
      // Main kickoff report — always surface even if stream events raced.
      updateAnswer(res.text);
      const last = history[history.length - 1];
      if (!(last && last.role === "assistant" && last.content === res.text)) {
        history.push({
          role: "assistant",
          content: res.text,
          at: new Date().toISOString(),
        });
      }
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
      reportHeight();
      askEl.focus();
    } else if (res?.ok) {
      // Invoke returns after the run finishes; clear spinner even if agent-done
      // IPC is delayed or was filtered (agent switch / race).
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
      if (res.text && !currentHasText) updateAnswer(res.text);
      if (res.waitingChoice && res.choice?.buttons?.length) {
        showAgentChoiceButtons({
          ...res.choice,
          agentId: res.agentId || sendAgentId || activeAgentId,
        });
      }
      reportHeight();
      askEl.focus();
    }
    // Stream handlers (onAgentDelta/Done) also finish the turn for the active agent.
  } catch (e) {
    if (activeAgentId && sendAgentId && activeAgentId !== sendAgentId) {
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
      return;
    }
    updateAnswer(e?.message || "Agent failed.");
    answerStillWorking = false;
    clearBuildingUnder();
    setBusy(false);
  }
}

// Accordion: clicking a turn's header opens it and collapses every other turn,
// keeping only one answer visible at a time. Clicking the open one closes it.
threadEl.addEventListener("click", (e) => {
  const copyBtn = e.target.closest(".chat-copy");
  if (copyBtn) {
    e.preventDefault();
    e.stopPropagation();
    void copyAnswerText(copyBtn);
    return;
  }
  // "Code" toggle on Build-mode artifact cards: swap the live preview for the
  // raw JSX the AI wrote (fetched once from the runner HTML's embedded source
  // block via main, then cached on the card). Copy button sits above it.
  const codeCopyBtn = e.target.closest(".md-code-copy");
  if (codeCopyBtn) {
    e.preventDefault();
    e.stopPropagation();
    if (codeCopyBtn.disabled) return;
    const codeEl = codeCopyBtn.closest(".md-artifact-code");
    const card = codeCopyBtn.closest(".md-artifact");
    const pre = codeEl?.querySelector("pre");
    const url =
      codeCopyBtn.getAttribute("data-url") ||
      card?.querySelector(".md-code")?.getAttribute("data-url") ||
      "";
    const markCopied = () => {
      codeCopyBtn.classList.add("copied");
      codeCopyBtn.innerHTML =
        `<span style="display:inline-flex;align-items:center;gap:4px">` +
        `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>` +
        `Copied</span>`;
      clearTimeout(codeCopyBtn._copiedTimer);
      codeCopyBtn._copiedTimer = setTimeout(() => {
        codeCopyBtn.classList.remove("copied");
        codeCopyBtn.textContent = "Copy";
      }, 1800);
    };
    void (async () => {
      let text = (pre && pre.textContent) || "";
      if (!text.trim() && url && window.lyknOverlay?.artifactCode) {
        codeCopyBtn.disabled = true;
        codeCopyBtn.textContent = "…";
        try {
          const res = await window.lyknOverlay.artifactCode(url);
          if (res && res.ok && res.code) {
            text = res.code;
            if (pre) pre.textContent = text;
          }
        } catch (_) {}
        codeCopyBtn.disabled = false;
        codeCopyBtn.textContent = "Copy";
      }
      if (!text.trim()) return;
      try {
        const ok = window.lyknOverlay?.copyText?.(text);
        if (ok === false) throw new Error("copy_failed");
        markCopied();
      } catch (_) {
        try {
          await navigator.clipboard.writeText(text);
          markCopied();
        } catch (_) {
          codeCopyBtn.textContent = "Failed";
          setTimeout(() => { codeCopyBtn.textContent = "Copy"; }, 1400);
        }
      }
    })();
    return;
  }
  const codeBtn = e.target.closest(".md-code");
  if (codeBtn) {
    e.preventDefault();
    const card = codeBtn.closest(".md-artifact");
    const frame = card?.querySelector("iframe");
    const codeEl = card?.querySelector(".md-artifact-code");
    if (!card || !frame || !codeEl) return;
    const showingCode = !codeEl.hidden;
    if (showingCode) {
      codeEl.hidden = true;
      frame.style.display = "";
      codeBtn.textContent = "Code";
      reportHeight();
      return;
    }
    const pre = codeEl.querySelector("pre");
    const reveal = () => {
      frame.style.display = "none";
      codeEl.hidden = false;
      codeBtn.textContent = "Preview";
      reportHeight();
    };
    if (pre.textContent) {
      reveal();
      return;
    }
    codeBtn.disabled = true;
    codeBtn.textContent = "Loading…";
    void (async () => {
      let res = null;
      try {
        res = await window.lyknOverlay.artifactCode(codeBtn.getAttribute("data-url") || "");
      } catch (_) {}
      codeBtn.disabled = false;
      if (res && res.ok && res.code) {
        pre.textContent = res.code;
        reveal();
      } else {
        codeBtn.textContent = "Code";
        pre.textContent = "";
      }
    })();
    return;
  }
  // Vault / neuron pull-up card: open the item in the main app (Vault note
  // or Synthesis for beliefs/facts/concepts).
  const vaultCard = e.target.closest(".md-vault");
  if (vaultCard) {
    e.preventDefault();
    e.stopPropagation();
    const noteId = vaultCard.getAttribute("data-note-id") || "";
    const toSynthesis = vaultCard.getAttribute("data-synthesis") === "1";
    try {
      if (toSynthesis) window.lyknOverlay.openSynthesis?.();
      else window.lyknOverlay.openVault?.(noteId);
    } catch (_) {}
    return;
  }
  const stepEl = e.target.closest(".md-step");
  if (stepEl) {
    const stepStatus = stepEl.getAttribute("data-status") || "done";
    if (stepStatus === "pending") return;
    const stepAgentId = stepEl.getAttribute("data-agent-id") || activeAgentId || "";
    const stepIndex = stepEl.getAttribute("data-step-index");
    if (stepIndex == null || stepIndex === "") return;
    const openBtn = e.target.closest(".md-step-open");
    // A step that can explain itself expands on click; going to the browser is
    // the button inside it. Otherwise clicking the row still jumps to the page.
    if (stepEl.getAttribute("data-expandable") === "1" && !openBtn) {
      // The native toggle happens after this handler, so `open` is still the
      // state we're leaving.
      const stepKey = `${stepAgentId}/${stepIndex}`;
      if (stepEl.open) expandedAgentSteps.delete(stepKey);
      else expandedAgentSteps.add(stepKey);
      // Growing the box mid-thread changes how much room the overlay needs.
      setTimeout(reportHeight, 0);
      return;
    }
    if (openBtn) {
      e.preventDefault();
      e.stopPropagation();
    }
    void window.lyknOverlay.agentShowStep?.(stepAgentId, Number(stepIndex));
    return;
  }
  // Edit on a vault/generated artifact → Build mode (source already seeded
  // in main when the artifact was built or loaded via loadNeuron).
  const editBuildBtn = e.target.closest(".md-edit-build");
  if (editBuildBtn) {
    e.preventDefault();
    e.stopPropagation();
    const url = editBuildBtn.getAttribute("data-url") || "";
    const title = editBuildBtn.getAttribute("data-title") || "Artifact";
    editBuildBtn.disabled = true;
    const orig = editBuildBtn.textContent;
    editBuildBtn.textContent = "…";
    void (async () => {
      try {
        if (url && window.lyknOverlay?.seedArtifactFromUrl) {
          await window.lyknOverlay.seedArtifactFromUrl(url, title);
        }
      } catch (_) {}
      setComposerMode("build");
      askEl.focus();
      editBuildBtn.textContent = orig;
      editBuildBtn.disabled = false;
      reportHeight();
    })();
    return;
  }
  // Edit on an image → Image mode with that image attached as the reference.
  const editImgBtn = e.target.closest(".md-edit-image");
  if (editImgBtn) {
    e.preventDefault();
    e.stopPropagation();
    const url = editImgBtn.getAttribute("data-url") || "";
    const title = editImgBtn.getAttribute("data-title") || "Image";
    if (!url) return;
    editImgBtn.disabled = true;
    const orig = editImgBtn.textContent;
    editImgBtn.textContent = "…";
    void (async () => {
      let dataUrl = "";
      try {
        const res = await window.lyknOverlay.fetchAsDataUrl?.(url);
        if (res && res.ok && res.dataUrl) dataUrl = res.dataUrl;
      } catch (_) {}
      if (dataUrl) {
        clearAttachments();
        addAttachmentObjects([
          {
            kind: "image",
            name: `${String(title).replace(/[^\w.-]+/g, "-").slice(0, 40) || "image"}.png`,
            dataUrl,
          },
        ]);
      }
      setComposerMode("image");
      askEl.focus();
      editImgBtn.textContent = orig;
      editImgBtn.disabled = false;
      reportHeight();
    })();
    return;
  }
  // Download buttons on generated images / Build-mode artifacts: save the
  // file into ~/Downloads via the main process (revealed in Finder) AND into
  // the user's Vault as a rich card.
  const dlBtn = e.target.closest(".md-dl");
  if (dlBtn) {
    e.preventDefault();
    if (dlBtn.disabled) return;
    const url = dlBtn.getAttribute("data-url") || "";
    const name = dlBtn.getAttribute("data-name") || "";
    const title = dlBtn.getAttribute("data-title") || "";
    const origLabel = dlBtn.textContent;
    dlBtn.disabled = true;
    dlBtn.textContent = "Saving…";
    void (async () => {
      let ok = false;
      let vaulted = false;
      try {
        const res = await window.lyknOverlay.downloadFile(url, name, title);
        ok = !!(res && res.ok);
        vaulted = !!(res && res.savedToVault);
      } catch (_) {
        ok = false;
      }
      dlBtn.textContent = ok ? (vaulted ? "Saved + Vault ✓" : "Saved ✓") : "Failed";
      setTimeout(() => {
        dlBtn.textContent = origLabel;
        dlBtn.disabled = false;
      }, 2200);
    })();
    return;
  }
  // Markdown links / sources / artifacts: always a new LYKN agent browser tab.
  const link = e.target.closest("a[href]");
  if (link) {
    e.preventDefault();
    const href = link.getAttribute("href");
    const label =
      (link.getAttribute("title") || link.textContent || "").trim().slice(0, 48) ||
      undefined;
    window.lyknOverlay.openUrl(href, label);
    return;
  }
  // Generated images open full-size in the LYKN browser.
  const genImg = e.target.closest(".md-img img");
  if (genImg && genImg.src) {
    e.preventDefault();
    window.lyknOverlay.openUrl(genImg.src);
    return;
  }
  const header = e.target.closest(".chat-q");
  if (!header) return;
  // Don't collapse/expand when the user just drag-highlighted the prompt.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && String(sel.toString() || "").trim()) return;
  const item = header.closest(".chat");
  if (!item) return;
  const willOpen = item.classList.contains("collapsed");
  threadEl.querySelectorAll(".chat").forEach((c) => c.classList.add("collapsed"));
  if (willOpen) item.classList.remove("collapsed");
  reportHeight();
});

threadEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const header = e.target.closest?.(".chat-q");
  if (!header || e.target !== header) return;
  e.preventDefault();
  header.click();
});

let streamingText = "";
window.lyknOverlay.onStatus((p) => {
  if (agentModeArmed) return;
  setThinkingStatus((p && p.status) || "Thinking…");
});
window.lyknOverlay.onSources((p) => {
  const list = Array.isArray(p?.sources) ? p.sources : [];
  researchSources = list.filter((s) => s && s.url).slice(0, 40);
  if (!researchSources.length) return;
  // New research results replace the Sources list for this turn.
  sideContext = {
    pageSource:
      (currentPageSource && currentPageSource.url && currentPageSource) ||
      (sideContext && sideContext.pageSource) ||
      null,
    links: mergeSourceLinks(researchSources, []),
    followups: (sideContext && sideContext.followups) || [],
  };
  syncSidePickerState();
  if (sidePanelView === "sources" || sidePanelView === "all") renderSidePanel();
});
window.lyknOverlay.onDelta((p) => {
  if (agentModeArmed) return;
  streamingText = p && p.text ? p.text : streamingText;
  updateAnswer(streamingText);
});
window.lyknOverlay.onDone((p) => {
  if (agentModeArmed) return;
  answerStillWorking = false;
  const finalText = (p && p.text) || streamingText;
  if (finalText) {
    updateAnswer(finalText);
    clearBuildingUnder();
    history.push({ role: "assistant", content: finalText, at: new Date().toISOString() });
    void persistCurrentSession();
    // Populate the left panel with sources, follow-ups, and options.
    void requestSuggestions(currentQuestion, finalText);
  } else if (!currentHasText && currentAnswerEl) {
    // Nothing came back — clear the spinner instead of leaving it spinning.
    currentHasText = true;
    updateAnswer("No response.");
  } else {
    clearBuildingUnder();
  }
  streamingText = "";
  setBusy(false);
  reportHeight();
  askEl.focus();
});
window.lyknOverlay.onError((p) => {
  if (agentModeArmed) return;
  answerStillWorking = false;
  updateAnswer((p && p.message) || "Something went wrong.");
  clearBuildingUnder();
  streamingText = "";
  setBusy(false);
  reportHeight();
});

// Agent Mode streams — scoped by agentId; only the active agent paints Glass.
window.lyknOverlay.onAgentSwitched((p) => {
  activeAgentId = p?.agentId || null;
  if (!agentModeArmed) return;
  const meta = {
    ...(p?.agent || {}),
    busy: p?.busy != null ? p.busy : p?.agent?.busy,
    partialText: p?.partialText != null ? p.partialText : p?.agent?.partialText,
    step: p?.step || p?.agent?.step,
    status: p?.agent?.status,
  };
  applyAgentTranscript(p?.history || [], meta);
  askEl.focus();
});
window.lyknOverlay.onAgentStatus((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  // Late status after the turn finished must not reopen a thinking spinner.
  if (!answerStillWorking && !busy) return;
  // Ensure an in-flight turn exists (e.g. switched back before first status).
  if (!currentAnswerEl && p?.agentId === activeAgentId) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Working…");
    setBusy(true);
  }
  setThinkingStatus((p && p.status) || "Working…");
});
window.lyknOverlay.onAgentDelta((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  if (!currentAnswerEl) {
    // Don't invent a new turn from a stray delta after the run already finished.
    if (!answerStillWorking && !busy) return;
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Working…");
    setBusy(true);
  }
  const status = String(p?.status || "").trim();
  const text = String(p?.text || "").trim();
  // Always paint the body when we have real text — working-through narrative,
  // streamed wrap-up, or final summary. Status/writing only drive the spinner.
  if (text) {
    agentStreamingText = text;
    updateAnswer(text);
    // Final when marked, or when the transcript is only finished step boxes.
    const looksFinal =
      !!p?.final ||
      (/!\[[^\]]*\]\(lykn-agent-step:/i.test(text) &&
        !/lykn-agent-step:\/\/[^)\s]+\/(?:live|pending)\b/i.test(text));
    const hasLiveStep = /lykn-agent-step:\/\/[^)\s]+\/live\b/i.test(text);
    if (looksFinal) {
      answerStillWorking = false;
      clearBuildingUnder();
    } else if (hasLiveStep) {
      // Spinner lives in the current step box — don't stack a second one.
      clearBuildingUnder();
    } else if (answerStillWorking && (p?.writing || status)) {
      const n = Number(p.chars) || text.length;
      const under =
        status ||
        (p?.writing
          ? n > 0
            ? `Writing output… (${n.toLocaleString()} chars)`
            : "Writing output…"
          : lastThinkingStatus || "Working…");
      ensureBuildingUnder(under);
    } else if (answerStillWorking) {
      // Text is on screen and nothing is still writing/working — don't
      // leave the thinking animation looping under a finished reply.
      clearBuildingUnder();
    }
    return;
  }
  if (status) {
    setThinkingStatus(status);
    return;
  }
  if (p?.writing) {
    const n = Number(p.chars) || 0;
    setThinkingStatus(n > 0 ? `Writing output… (${n.toLocaleString()} chars)` : "Writing output…");
  }
});
window.lyknOverlay.onAgentSources((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  const list = Array.isArray(p?.sources) ? p.sources : [];
  researchSources = list.filter((s) => s && s.url).slice(0, 40);
  if (!researchSources.length) return;
  sideContext = {
    pageSource: (sideContext && sideContext.pageSource) || null,
    links: mergeSourceLinks(researchSources, []),
    followups: (sideContext && sideContext.followups) || [],
  };
  syncSidePickerState();
  if (sidePanelView === "sources" || sidePanelView === "all") renderSidePanel();
});
window.lyknOverlay.onAgentWaiting?.((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  setAgentWaiting(p);
});
window.lyknOverlay.onAgentDone((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  answerStillWorking = false;
  const finalText = (p && p.text) || agentStreamingText;
  if (!currentAnswerEl && finalText) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Done");
  }
  if (finalText) {
    updateAnswer(finalText);
    clearBuildingUnder();
    // History is owned by main agent registry; keep local transcript in sync.
    const last = history[history.length - 1];
    if (!(last && last.role === "assistant" && last.content === finalText)) {
      history.push({ role: "assistant", content: finalText, at: new Date().toISOString() });
    }
    if (p?.choice?.buttons?.length) {
      showAgentChoiceButtons({ ...p.choice, agentId: p.agentId || activeAgentId });
    } else if (!p?.monitoring) {
      // Prefer runtime tips for this finished turn; LLM upgrades below.
      const runtimeTips = Array.isArray(p?.suggestions)
        ? p.suggestions
            .map((s) => (typeof s === "string" ? s : s?.prompt || s?.label || ""))
            .map((s) => String(s || "").trim())
            .filter(Boolean)
            .slice(0, 3)
        : [];
      if (runtimeTips.length) {
        sideContext = {
          ...(sideContext || {}),
          pageSource: (sideContext && sideContext.pageSource) || null,
          links: (sideContext && sideContext.links) || [],
          followups: runtimeTips,
        };
        syncSidePickerState();
        if (sidePanelView && sidePanelView !== "watch") renderSidePanel();
      }
      void requestSuggestions(currentQuestion, finalText);
    }
  } else if (!currentHasText && currentAnswerEl && !p?.stopped) {
    currentHasText = true;
    updateAnswer("No response.");
  } else {
    clearBuildingUnder();
  }
  agentStreamingText = "";
  setBusy(false);
  // Parked runs finish the turn but keep watching — keep the pulse on screen.
  // The done payload says so too, which covers a pause that never sent a
  // separate waiting event: without this the spinner just stops and a run
  // that is still waiting on the user reads as finished.
  if (!pendingAgentWaiting && (p?.waitingSignIn || p?.waitingChoice)) {
    setAgentWaiting({
      waiting: true,
      kind: p.waitingChoice ? "choice" : "signin",
      label: p.waitingChoice ? "Waiting for your choice" : "",
    });
  } else if (pendingAgentWaiting) renderAgentWaitingRow();
  reportHeight();
  askEl.focus();
});
window.lyknOverlay.onAgentChoice((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  if (!p?.buttons?.length) return;
  if (!currentAnswerEl && p?.message) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Choice");
    updateAnswer(p.message);
  }
  showAgentChoiceButtons(p);
  answerStillWorking = false;
  clearBuildingUnder();
  setBusy(false);
  reportHeight();
});
window.lyknOverlay.onAgentError((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  answerStillWorking = false;
  if (!currentAnswerEl) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Error");
  }
  updateAnswer((p && p.message) || "Agent error.");
  clearBuildingUnder();
  agentStreamingText = "";
  setBusy(false);
  reportHeight();
});
// LYKN scraped the page the user is viewing — remember it so requestSuggestions
// can show it as a source (visible proof the scrape happened).
window.lyknOverlay.onPageSource((p) => {
  if (p && p.url) currentPageSource = { url: p.url, title: p.title || "" };
});

const nightBriefEl = document.getElementById("night-brief");
const nightBriefProjectEl = document.getElementById("night-brief-project");
const nightBriefBodyEl = document.getElementById("night-brief-body");
const nightBriefCloseEl = document.getElementById("night-brief-close");
const NIGHT_BRIEF_DISMISS_KEY = "lykn_night_brief_dismissed";

function nightBriefDismissToken(briefs) {
  if (!Array.isArray(briefs) || !briefs.length) return "";
  return briefs
    .map((b) => `${b.id || ""}:${b.setAt || ""}`)
    .sort()
    .join("|");
}

function hideNightBriefBanner() {
  if (!nightBriefEl) return;
  nightBriefEl.classList.remove("show");
  nightBriefEl.hidden = true;
}

function showNightBriefBanner(briefs) {
  if (!nightBriefEl || !nightBriefBodyEl || !nightBriefProjectEl) return;
  const token = nightBriefDismissToken(briefs);
  if (!token) {
    hideNightBriefBanner();
    return;
  }
  try {
    if (localStorage.getItem(NIGHT_BRIEF_DISMISS_KEY) === token) {
      hideNightBriefBanner();
      return;
    }
  } catch (_) {}

  const primary = briefs[0];
  const extra = briefs.length > 1 ? ` (+${briefs.length - 1} more project${briefs.length > 2 ? "s" : ""})` : "";
  nightBriefProjectEl.textContent = `${primary.projectName || "Project"}${extra}`;
  nightBriefBodyEl.innerHTML = renderMarkdown(String(primary.value || ""));
  nightBriefEl.hidden = false;
  nightBriefEl.classList.add("show");
  nightBriefEl.dataset.dismissToken = token;
}

async function refreshNightBriefBanner() {
  if (!window.lyknOverlay?.getNightBriefs) return;
  try {
    const data = await window.lyknOverlay.getNightBriefs();
    if (data?.ok && data.briefs?.length) showNightBriefBanner(data.briefs);
    else hideNightBriefBanner();
  } catch (_) {
    hideNightBriefBanner();
  }
}

if (nightBriefCloseEl) {
  nightBriefCloseEl.addEventListener("click", () => {
    const token = nightBriefEl?.dataset?.dismissToken || "";
    if (token) {
      try {
        localStorage.setItem(NIGHT_BRIEF_DISMISS_KEY, token);
      } catch (_) {}
    }
    hideNightBriefBanner();
  });
}

window.lyknOverlay.onShown(() => {
  // Remeasure after show — a stale height leaves the composer buttons clipped.
  lastReportedHeight = -1;
  lastReportedWidth = -1;
  reportHeight();
  setTimeout(() => {
    lastReportedHeight = -1;
    reportHeight();
    askEl.focus();
  }, 40);
  setTimeout(() => {
    lastReportedHeight = -1;
    reportHeight();
  }, 220);
  void refreshNightBriefBanner();
});

// Clicking back into the bar after Cursor/another app often leaves the macOS
// panel non-key — caret looks focused but keys go nowhere. Re-key via main.
function ensureComposerKeyboard() {
  try {
    window.lyknOverlay.focusComposer?.();
  } catch (_) {}
  try {
    askEl.focus({ preventScroll: true });
  } catch (_) {
    askEl.focus();
  }
}
if (typeof window.lyknOverlay.onFocusComposer === "function") {
  window.lyknOverlay.onFocusComposer(() => {
    try {
      askEl.focus({ preventScroll: true });
    } catch (_) {
      askEl.focus();
    }
  });
}
askEl.addEventListener("pointerdown", () => {
  ensureComposerKeyboard();
});
window.addEventListener("focus", () => {
  // Returning to the overlay window — restore caret without fighting menus.
  if (document.activeElement === askEl || !document.activeElement || document.activeElement === document.body) {
    setTimeout(() => {
      try {
        askEl.focus({ preventScroll: true });
      } catch (_) {
        askEl.focus();
      }
    }, 0);
  }
});

// Drag the panel via the titlebar handle (or the collapsed bubble). Electron
// panel windows sometimes drop pointerup while setBounds is racing the cursor
// — without a buttons check / lostpointercapture handler the bar stays glued
// to the mouse and every move floods IPC (which stalls the cursor badly).
// True while any overlay drag handle is mid-gesture (Esc cancels drag first).
let overlayDragActive = false;
const overlayDragEnders = new Set();

function bindOverlayDrag(el, { ignoreTarget, onClick, dragClass } = {}) {
  if (!el) return;
  let dragging = false;
  let moved = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  let pendingDx = 0;
  let pendingDy = 0;
  let raf = 0;

  const flush = () => {
    raf = 0;
    if (!pendingDx && !pendingDy) return;
    const dx = pendingDx;
    const dy = pendingDy;
    pendingDx = 0;
    pendingDy = 0;
    window.lyknOverlay.moveBy(dx, dy);
  };

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    overlayDragActive = false;
    const id = e && e.pointerId != null ? e.pointerId : pointerId;
    pointerId = null;
    if (dragClass) el.classList.remove(dragClass);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (pendingDx || pendingDy) flush();
    try {
      if (id != null) el.releasePointerCapture(id);
    } catch (_) {
      /* already released */
    }
    try {
      window.lyknOverlay.moveEnd();
    } catch (_) {
      /* older preload */
    }
    if (onClick && !moved) onClick();
    moved = false;
  };

  overlayDragEnders.add(end);

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (ignoreTarget && ignoreTarget(e.target)) return;
    dragging = true;
    overlayDragActive = true;
    moved = false;
    pointerId = e.pointerId;
    lastX = e.screenX;
    lastY = e.screenY;
    pendingDx = 0;
    pendingDy = 0;
    if (dragClass) el.classList.add(dragClass);
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {
      /* capture optional */
    }
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // Primary button no longer down — pointerup was lost (common on macOS
    // panel windows while the HWND is being moved under the cursor).
    if ((e.buttons & 1) === 0) {
      end(e);
      return;
    }
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (!dx && !dy) return;
    // Ignore tiny jitter so a click doesn't start a "drag".
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    moved = true;
    lastX = e.screenX;
    lastY = e.screenY;
    pendingDx += dx;
    pendingDy += dy;
    if (!raf) raf = requestAnimationFrame(flush);
  });

  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", end);
  window.addEventListener("blur", () => end());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) end();
  });
}

const dragEl = document.getElementById("drag");
bindOverlayDrag(dragEl, {
  dragClass: "dragging",
  ignoreTarget: (t) =>
    !!(t && t.closest && t.closest(".bar-btn, .side-picker-btn, .mode-badge")),
});

// ── Collapse to a single LYKN icon bubble ──────────────────────────────────
const bubbleEl = document.getElementById("bubble");

function collapseOverlay() {
  setMenuOpen(false);
  setPanelPickerOpen(false);
  document.body.classList.add("collapsed");
  window.lyknOverlay.collapse(true);
}

function expandOverlay() {
  document.body.classList.remove("collapsed");
  window.lyknOverlay.collapse(false);
  // Force a fresh size report now that the panel is visible again.
  lastReportedHeight = -1;
  lastReportedWidth = -1;
  reportHeight();
  askEl.focus();
}

// Click the glowing LYKN mark in the bar to collapse everything.
dotEl.addEventListener("click", collapseOverlay);

// Bubble: drag to reposition, or click (no drag) to expand.
bindOverlayDrag(bubbleEl, { onClick: expandOverlay });

// ── Dictation ────────────────────────────────────────────────────────────
// Record mic audio with MediaRecorder, then hand the bytes to the main process
// to transcribe (whisper) and append the text to the input — same flow as the
// app's chat-bar mic button.
const micEl = document.getElementById("mic");
let recorder = null;
let mediaStream = null;
let audioChunks = [];
let recording = false;
let transcribing = false;
const RECORD_MIME = (() => {
  try {
    return MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
  } catch (_) {
    return "audio/webm";
  }
})();
function setMicState() {
  micEl.classList.toggle("recording", recording);
  micEl.classList.toggle("transcribing", transcribing);
  // Voice mode owns the mic button (stop control) — don't overwrite its title
  // or the composer placeholder while a session is live / connecting.
  if (voiceActive || voiceStarting) {
    micEl.disabled = false;
    micEl.title = "Stop voice mode";
    micEl.setAttribute("aria-label", "Stop voice mode");
    return;
  }
  micEl.disabled = transcribing;
  micEl.title = recording ? "Stop recording" : transcribing ? "Transcribing…" : "Dictate";
  micEl.setAttribute("aria-label", micEl.title);
  askEl.placeholder = recording
    ? "Listening… click the mic to stop"
    : transcribing
      ? "Transcribing…"
      : COMPOSER_MODES[composerMode].placeholder;
}

async function startDictation() {
  if (recording || transcribing || busy) return;
  const ok = await window.lyknOverlay.ensureMic();
  if (!ok) {
    startTurn("Dictation");
    updateAnswer(
      "LYKN needs Microphone access. Enable it in System Settings → Privacy & Security → Microphone, then try again.",
    );
    reportHeight();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    return;
  }
  mediaStream = stream;
  audioChunks = [];
  recorder = new MediaRecorder(stream, { mimeType: RECORD_MIME });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  recorder.onstop = async () => {
    try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    mediaStream = null;
    recorder = null;
    recording = false;
    const blob = new Blob(audioChunks, { type: RECORD_MIME });
    audioChunks = [];
    if (blob.size < 2000) { setMicState(); return; }
    transcribing = true;
    setMicState();
    try {
      const buf = await blob.arrayBuffer();
      const res = await window.lyknOverlay.transcribe(buf, RECORD_MIME, askEl.value);
      const text = res && res.text ? res.text.trim() : "";
      if (text) {
        const cur = askEl.value.trim();
        askEl.value = cur ? `${cur} ${text}` : text;
        autoGrowAsk();
      }
    } catch (_) {}
    transcribing = false;
    setMicState();
    askEl.focus();
  };
  recorder.onerror = () => {
    recording = false;
    transcribing = false;
    setMicState();
  };
  recorder.start();
  recording = true;
  setMicState();
}

function stopDictation() {
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch (_) {}
}

micEl.addEventListener("click", () => {
  // During voice, the mic is a one-click stop — no need to open More.
  if (voiceActive || voiceStarting) {
    void stopVoice();
    return;
  }
  if (recording) stopDictation();
  else startDictation();
});

// ── Drag & drop attachments ────────────────────────────────────────────────
const attachmentsEl = document.getElementById("attachments");
const wrapEl = document.getElementById("wrap");
const attachments = [];
let attachSeq = 0;

const FILE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />' +
  '<path d="M14 2v5h5" /></svg>';
const X_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.toggle("show", attachments.length > 0);
  for (const a of attachments) {
    const chip = document.createElement("div");
    chip.className = "chip";
    if (a.kind === "image" && a.dataUrl) {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.alt = a.name || "image";
      chip.appendChild(img);
    } else {
      const ico = document.createElement("span");
      ico.className = "chip-ico";
      ico.innerHTML = FILE_ICON_SVG;
      chip.appendChild(ico);
    }
    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = a.name || (a.kind === "image" ? "image" : "file");
    chip.appendChild(name);

    const x = document.createElement("span");
    x.className = "chip-x";
    x.title = "Remove";
    x.innerHTML = X_SVG;
    x.addEventListener("click", () => {
      const i = attachments.findIndex((it) => it.id === a.id);
      if (i >= 0) attachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    attachmentsEl.appendChild(chip);
  }
  reportHeight();
}

function clearAttachments() {
  attachments.length = 0;
  renderAttachments();
}

function isTextFile(file) {
  if (file.type.startsWith("text/")) return true;
  if (["application/json", "application/xml"].includes(file.type)) return true;
  return /\.(txt|md|markdown|csv|json|xml|ya?ml|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|css|html?|sh|sql|log)$/i.test(
    file.name || "",
  );
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsText(file);
  });
}

// Push pre-built attachment objects (from the native picker) onto the list.
function addAttachmentObjects(list) {
  for (const a of list || []) {
    if (attachments.length >= 6) break;
    if (!a || (a.kind === "image" && !a.dataUrl) || (a.kind === "text" && !a.text)) continue;
    attachments.push({ id: ++attachSeq, kind: a.kind, name: a.name, dataUrl: a.dataUrl, text: a.text });
  }
  renderAttachments();
  askEl.focus();
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (attachments.length >= 6) break; // keep payloads sane
    try {
      if (file.type.startsWith("image/")) {
        const dataUrl = await readAsDataURL(file);
        attachments.push({ id: ++attachSeq, kind: "image", name: file.name, dataUrl });
      } else if (isTextFile(file)) {
        const text = await readAsText(file);
        attachments.push({ id: ++attachSeq, kind: "text", name: file.name, text });
      } else {
        // Unsupported binary — note it so the user knows it wasn't attached.
        attachments.push({
          id: ++attachSeq,
          kind: "text",
          name: file.name,
          text: `(Unsupported file type: ${file.type || "unknown"}, not included.)`,
        });
      }
    } catch (_) {
      /* skip unreadable file */
    }
  }
  renderAttachments();
  askEl.focus();
}

// ── "More" inline drawer (inside composer) ─────────────────────────────────
const composerEl = document.getElementById("composer");
const moreBtn = document.getElementById("more");
const menuEl = document.getElementById("menu");
const historyPanelEl = document.getElementById("history-panel");
const historyListEl = document.getElementById("history-list");
let historyOpen = false;
let moreUserOpen = false;

// The three-dot menu lives in its OWN little vibrancy window next to the bar
// (see menu.html / main.cjs) so the gap between it and the chat stays truly
// transparent. This just asks main to show/hide it; main echoes the actual
// visibility back via onMenuVisible so `moreUserOpen` never drifts.
// (Main hides the picker card when the menu opens, and vice versa — only one
// floating card sits next to the bar at a time.)
function setMenuOpen(open) {
  try {
    window.lyknOverlay.setMenu(!!open);
  } catch (_) {}
}

window.lyknOverlay.onMenuVisible((visible) => {
  moreUserOpen = !!visible;
  moreBtn.classList.toggle("active", moreUserOpen);
});

// Remote control from the menu window — actions run HERE because this
// renderer owns voice/listen/watch/stealth/attachment/session state. Most
// commands just click the existing (now hidden) drawer buttons.
window.__lyknMenuCmd = (name, arg) => {
  switch (name) {
    case "menu-new":
      void startNewOverlayChat();
      break;
    case "voice":
      document.getElementById("voice").click();
      break;
    case "listen":
    case "menu-transcribe": {
      const b = document.getElementById("menu-transcribe");
      if (b) b.click();
      break;
    }
    case "menu-live-watch": {
      const b = document.getElementById("menu-live-watch");
      if (b) b.click();
      break;
    }
    case "menu-image-gen": {
      // Clicks the hidden drawer button, which arms image mode — see its
      // listener below. (Never auto-sends; the user presses Send.)
      const b = document.getElementById("menu-image-gen");
      if (b) b.click();
      break;
    }
    case "menu-build": {
      const b = document.getElementById("menu-build");
      if (b) b.click();
      break;
    }
    case "menu-agent": {
      const b = document.getElementById("menu-agent");
      if (b) b.click();
      break;
    }
    case "menu-research": {
      const b = document.getElementById("menu-research");
      if (b) b.click();
      break;
    }
    case "menu-translate": {
      const b = document.getElementById("menu-translate");
      if (b) b.click();
      break;
    }
    case "menu-stealth": {
      const b = document.getElementById("menu-stealth");
      if (b) b.click();
      break;
    }
    case "menu-open":
      try {
        window.lyknOverlay.openMain();
      } catch (_) {}
      break;
    case "open-overlay-session":
      void (async () => {
        try {
          const session = await window.lyknOverlay.getOverlaySession(arg);
          if (session) await loadOverlaySession(session);
        } catch (_) {}
      })();
      break;
    case "select-project":
      void (async () => {
        // Fresh thread scoped to the chosen project (or clear → general chat).
        await startNewOverlayChat();
        if (arg && arg.id) {
          setScopedProject({ id: arg.id, name: arg.name || "Project" });
          askEl.placeholder = `Ask about ${String(arg.name || "this project").slice(0, 40)}…`;
        } else {
          setScopedProject(null);
        }
        askEl.focus();
      })();
      break;
  }
};

// Toggle-state snapshot for the menu window's badges, read off the hidden
// drawer DOM that the feature code already keeps up to date.
window.__lyknMenuState = () => {
  const voiceEl2 = document.getElementById("voice");
  const listenEl2 = document.getElementById("listen");
  const watchBtn = document.getElementById("menu-live-watch");
  const stealthBtn2 = document.getElementById("menu-stealth");
  const text = (id) => {
    const el = document.getElementById(id);
    return el ? el.textContent : "";
  };
  return {
    currentSessionId,
    voiceActive: !!(voiceEl2 && voiceEl2.classList.contains("voice-active")),
    voiceLabel: text("voice-label"),
    listening: !!(listenEl2 && listenEl2.classList.contains("listening")),
    listenLabel: text("listen-label"),
    watchOn: !!(watchBtn && watchBtn.getAttribute("aria-pressed") === "true"),
    watchState: text("live-watch-state"),
    stealthOn: !!(stealthBtn2 && stealthBtn2.getAttribute("aria-pressed") === "true"),
    stealthState: text("stealth-state"),
    imageModeOn: composerMode === "image",
    buildModeOn: composerMode === "build",
    agentModeOn: composerMode === "agent",
    researchModeOn: composerMode === "research",
    translateModeOn: composerMode === "translate",
    transcribeModeOn: composerMode === "transcribe" || listening,
    scopedProjectId: scopedProject?.id || null,
    scopedProjectName: scopedProject?.name || null,
  };
};

function setHistoryOpen(open) {
  historyOpen = open;
  historyPanelEl.classList.toggle("show", open);
  menuEl.style.display = open ? "none" : "";
  if (open && !moreUserOpen) setMenuOpen(true);
  reportHeight();
}

const HISTORY_TIME_GROUPS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 Days" },
  { key: "last30", label: "Last 30 Days" },
  { key: "older", label: "Older" },
];

function historyTime(iso) {
  const t = new Date(iso || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function historyBucketForTime(time, now) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  const dayMs = 86400000;
  if (time >= startOfTodayMs) return "today";
  if (time >= startOfTodayMs - dayMs) return "yesterday";
  if (time >= startOfTodayMs - 7 * dayMs) return "last7";
  if (time >= startOfTodayMs - 30 * dayMs) return "last30";
  return "older";
}

function groupHistoryItems(items) {
  const now = Date.now();
  const buckets = new Map(HISTORY_TIME_GROUPS.map((g) => [g.key, []]));
  for (const item of items) {
    buckets.get(historyBucketForTime(historyTime(item.updatedAt), now)).push(item);
  }
  return HISTORY_TIME_GROUPS.map((g) => ({ ...g, items: buckets.get(g.key) })).filter(
    (g) => g.items.length,
  );
}

function historyItemButton(item, active) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-item" + (active ? " active" : "");
  btn.innerHTML =
    '<span class="hi-dot" aria-hidden="true"></span>' +
    `<span class="hi-title">${escapeHtml(item.title || "New Chat")}</span>`;
  return btn;
}

async function refreshHistoryList() {
  historyListEl.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    const data = await window.lyknOverlay.listChats();
    renderHistoryList(data);
  } catch (_) {
    historyListEl.innerHTML = '<div class="history-empty">Could not load chats.</div>';
  }
}

function renderHistoryList(data) {
  historyListEl.innerHTML = "";
  const overlay = ((data && data.overlay) || []).map((item) => ({ ...item, source: "overlay" }));
  const app = ((data && data.app) || []).map((item) => ({ ...item, source: "app" }));
  const all = [...overlay, ...app].sort(
    (a, b) => historyTime(b.updatedAt) - historyTime(a.updatedAt),
  );

  if (!all.length) {
    historyListEl.innerHTML = '<div class="history-empty">No chats yet.</div>';
    if (data && data.error === "not_signed_in") {
      const sign = document.createElement("div");
      sign.className = "history-signin";
      sign.innerHTML = "Sign in to LYKN to see app chats.<br>";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "Open LYKN to sign in";
      openBtn.addEventListener("click", () => {
        setHistoryOpen(false);
        setMenuOpen(false);
        window.lyknOverlay.openMain();
      });
      sign.appendChild(openBtn);
      historyListEl.appendChild(sign);
    }
    return;
  }

  for (const group of groupHistoryItems(all)) {
    const g = document.createElement("div");
    g.className = "history-group";
    g.textContent = group.label;
    historyListEl.appendChild(g);
    for (const item of group.items) {
      const active = item.source === "overlay" && item.id === currentSessionId;
      const btn = historyItemButton(item, active);
      btn.addEventListener("click", async () => {
        if (item.source === "overlay") {
          const session = await window.lyknOverlay.getOverlaySession(item.id);
          if (session) await loadOverlaySession(session);
        } else {
          setHistoryOpen(false);
          setMenuOpen(false);
          window.lyknOverlay.openAppChat(item.id);
        }
      });
      historyListEl.appendChild(btn);
    }
  }

  if (data && data.error === "not_signed_in" && overlay.length) {
    const sign = document.createElement("div");
    sign.className = "history-signin";
    sign.textContent = "Sign in to see app chats too.";
    historyListEl.appendChild(sign);
  }
}

moreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (moreUserOpen) {
    setMenuOpen(false);
  } else {
    setHistoryOpen(false);
    setMenuOpen(true);
  }
});

document.addEventListener("click", (e) => {
  if (!moreUserOpen) return;
  if (e.target.closest("#composer")) return;
  setMenuOpen(false);
});

document.getElementById("menu-new").addEventListener("click", () => {
  void startNewOverlayChat();
});

document.getElementById("new-chat").addEventListener("click", () => {
  void startNewOverlayChat();
});

document.getElementById("menu-history").addEventListener("click", () => {
  setHistoryOpen(true);
  void refreshHistoryList();
});

document.getElementById("history-back").addEventListener("click", () => {
  setHistoryOpen(false);
  menuEl.style.display = "";
});

document.getElementById("history-new").addEventListener("click", () => {
  void startNewOverlayChat();
});

async function openFilePicker() {
  try {
    const items = await window.lyknOverlay.pickFiles();
    addAttachmentObjects(items);
  } catch (_) {}
}

// Drag-select a region of the screen and attach it as an image — lets the user
// grab whatever is on screen without downloading a file (the panel window can't
// receive OS drags, so this is the "drag straight from the screen" path).
let snipping = false;
async function snipFromScreen() {
  if (snipping) return;
  snipping = true;
  try {
    const item = await window.lyknOverlay.snipScreen();
    if (item && item.dataUrl) addAttachmentObjects([item]);
  } catch (_) {
  } finally {
    snipping = false;
  }
}

// Toolbar attach button — the reliable way to add files to the bar. (macOS
// blocks OS file drops onto this non-activating panel window, so the picker is
// the dependable path; drag-and-drop still works where the OS allows it.)
const attachBtn = document.getElementById("attach");
if (attachBtn) attachBtn.addEventListener("click", () => void openFilePicker());

// Toolbar snip button — capture a screen region straight into the bar.
const snipBtn = document.getElementById("snip");
if (snipBtn) snipBtn.addEventListener("click", () => void snipFromScreen());

// Menu → "Create an image": switch the composer into image mode — every send
// generates a picture (GPT Image 2) until the user switches back to chat.
// Clicking it again while already in image mode toggles back to chat. Never
// auto-send on switch — the user may still be mid-prompt; they press Send.
const menuImageGenEl = document.getElementById("menu-image-gen");
if (menuImageGenEl) {
  menuImageGenEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "image" ? "chat" : "image");
    askEl.focus();
  });
}

// Menu → "Build mode": switch the composer into build mode — sends have LYKN
// code the thing out as a live React artifact ("make me a landing page",
// "build a budget tracker"…) until the user switches back to chat. Clicking
// it again toggles back. Never auto-send on switch — the user may still be
// mid-prompt; the brief goes out when they press Send.
const menuBuildEl = document.getElementById("menu-build");
if (menuBuildEl) {
  menuBuildEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "build" ? "chat" : "build");
    askEl.focus();
  });
}

const menuAgentEl = document.getElementById("menu-agent");
if (menuAgentEl) {
  menuAgentEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "agent" ? "chat" : "agent");
    askEl.focus();
  });
}

const menuResearchEl = document.getElementById("menu-research");
if (menuResearchEl) {
  menuResearchEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "research" ? "chat" : "research");
    askEl.focus();
  });
}

const menuTranslateEl = document.getElementById("menu-translate");
if (menuTranslateEl) {
  menuTranslateEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "translate" ? "chat" : "translate");
    askEl.focus();
  });
}

const menuTranscribeEl = document.getElementById("menu-transcribe");
if (menuTranscribeEl) {
  menuTranscribeEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "transcribe" || listening ? "chat" : "transcribe");
    askEl.focus();
  });
}

// Never fire immediately off whatever is typed — the prompt may be unfinished.
// Arm the mode and let the user press Send when they're ready.
const menuBrowserActEl = document.getElementById("menu-browser-act");
if (menuBrowserActEl) {
  menuBrowserActEl.addEventListener("click", () => {
    setMenuOpen(false);
    browserActArmed = true;
    askEl.placeholder = "Describe what to do on this page, then Send…";
    askEl.focus();
  });
}

if (browserActCancelEl) browserActCancelEl.addEventListener("click", () => hideBrowserActPanel());
if (browserActRunEl) {
  browserActRunEl.addEventListener("click", () => {
    if (executingBrowser || busy) return;
    void executeBrowserAct();
  });
}

document.getElementById("menu-open").addEventListener("click", () => {
  setMenuOpen(false);
  try {
    window.lyknOverlay.openMain();
  } catch (_) {}
});

// Content protection toggle — hide the overlay from screen recordings/shares.
// Keeps the menu open so the user sees the On/Off state flip in place.
const stealthBtn = document.getElementById("menu-stealth");
const stealthStateEl = document.getElementById("stealth-state");
function renderStealthState(on) {
  if (!stealthBtn) return;
  stealthBtn.setAttribute("aria-pressed", on ? "true" : "false");
  if (stealthStateEl) stealthStateEl.textContent = on ? "On" : "Off";
}
(async () => {
  try {
    renderStealthState(await window.lyknOverlay.getContentProtection());
  } catch (_) {}
})();
if (stealthBtn) {
  stealthBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const current = stealthBtn.getAttribute("aria-pressed") === "true";
    try {
      const next = await window.lyknOverlay.setContentProtection(!current);
      renderStealthState(!!next);
    } catch (_) {}
  });
}

// Live Watch — feed lives in the side panel; chat thread stays for user prompts.
const liveWatchBtn = document.getElementById("menu-live-watch");
const liveWatchStateEl = document.getElementById("live-watch-state");

function appendWatchCommentary(text, { system = false, alert = false } = {}) {
  const t = String(text || "").trim();
  if (!t) return;
  watchFeedItems.push({ text: t, system: !!system, alert: !!alert, at: Date.now() });
  if (watchFeedItems.length > 40) watchFeedItems = watchFeedItems.slice(-40);
  if (liveWatchEnabled) {
    if (sidePanelView !== "watch") setSidePanelView("watch");
    else renderWatchSidePanel();
    reportHeight();
  }
}

function startWatchFeed() {
  watchFeedActive = true;
  lastWatchCommentaryPosted = "";
  watchFeedItems = [];
  watchActiveRules = [];
  watchSuggestions = { followups: [], links: [] };
  lastWatchSuggestKey = "";
  watchPageTitle = "";
  watchPageUrl = "";
  appendWatchCommentary("Live feedback is on.", { system: true });
  applyLiveWatchLayout(true);
  startWatchConnPoll();
}

function stopWatchFeed() {
  if (!watchFeedActive) return;
  stopWatchConnPoll();
  watchFeedActive = false;
  appendWatchCommentary("Live feedback stopped.", { system: true });
  lastWatchCommentaryPosted = "";
  watchActiveRules = [];
  watchSuggestions = { followups: [], links: [] };
  lastWatchSuggestKey = "";
  if (watchSuggestTimer) clearTimeout(watchSuggestTimer);
  watchSuggestTimer = null;
  if (sidePanelView === "watch") {
    sidePanelView = "";
    showSide(false);
    updateSidePickerLabel();
  }
}

async function requestWatchSuggestions(status) {
  const commentary = String(status?.commentary || status?.summary || "").trim();
  if (commentary.length < 8) return;
  const pageTitle = String(status?.pageTitle || watchPageTitle || "").trim();
  const pageUrl = String(status?.pageUrl || watchPageUrl || "").trim();
  const summary = String(status?.summary || "").trim();
  const contextSource = status?.contextSource || watchContextSource;
  const suggestKey = [pageUrl, pageTitle, commentary].filter(Boolean).join("|");
  if (suggestKey === lastWatchSuggestKey) return;
  lastWatchSuggestKey = suggestKey;

  const contextLines = [];
  if (pageTitle) contextLines.push(`Page: ${pageTitle}`);
  if (pageUrl) contextLines.push(`URL: ${pageUrl}`);
  if (contextSource === "vision") {
    contextLines.push("View: screen capture (app or game — may not be a browser page)");
  } else if (contextSource === "extension") {
    contextLines.push("View: live browser page via Chrome Live Feed");
  }
  contextLines.push(`What they're doing now: ${commentary}`);
  if (summary && summary !== commentary) {
    contextLines.push(`Recent activity: ${summary.slice(0, 600)}`);
  }

  let data = null;
  try {
    data = await window.lyknOverlay.suggest(
      "Suggest follow-ups about what the user is doing, the page they are on, and sensible next actions.",
      contextLines.join("\n"),
      { mode: "live_watch" },
    );
  } catch (_) {
    data = null;
  }
  watchSuggestions = {
    followups: (data && Array.isArray(data.followups) ? data.followups : []).filter(Boolean),
    links: (data && Array.isArray(data.links) ? data.links : []).filter((l) => l && l.url),
  };
  if (sidePanelView === "watch" || sidePanelView === "all") renderSidePanel();
}

function handleLiveWatchCommentary(status) {
  if (!status?.enabled) return;
  if (Array.isArray(status.rules)) watchActiveRules = status.rules.slice();
  const commentary = String(status?.commentary || status?.summary || "").trim();
  if (!commentary || !status?.isNewCommentary) return;
  if (commentary === lastWatchCommentaryPosted) return;
  lastWatchCommentaryPosted = commentary;
  const isAlert = status.commentaryKind === "alert";
  appendWatchCommentary(commentary, { alert: isAlert });
  if (!isAlert) {
    if (watchSuggestTimer) clearTimeout(watchSuggestTimer);
    watchSuggestTimer = setTimeout(() => {
      watchSuggestTimer = null;
      void requestWatchSuggestions(status);
    }, 400);
  }
}

function renderLiveWatchState(status) {
  const on = !!(status && status.enabled);
  const wasOn = liveWatchEnabled;
  liveWatchEnabled = on;
  if (status?.contextSource) watchContextSource = status.contextSource;
  if (typeof status?.pageTitle === "string") watchPageTitle = status.pageTitle;
  if (typeof status?.pageUrl === "string") watchPageUrl = status.pageUrl;
  if (typeof status?.extensionConnected === "boolean") {
    watchExtensionConnected = status.extensionConnected;
  }
  if (liveWatchBtn) {
    liveWatchBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (liveWatchStateEl) liveWatchStateEl.textContent = on ? "On" : "Off";
  if (Array.isArray(status?.rules)) watchActiveRules = status.rules.slice();
  if (on && !wasOn) startWatchFeed();
  if (!on && wasOn) stopWatchFeed();
  if (on && sidePanelView === "watch") renderWatchSidePanel();
  else if (on && wasOn) reportHeight();
}

(async () => {
  try {
    renderLiveWatchState(await window.lyknOverlay.getLiveWatch());
  } catch (_) {}
})();

if (liveWatchBtn) {
  liveWatchBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const current = liveWatchBtn.getAttribute("aria-pressed") === "true";
    try {
      const next = await window.lyknOverlay.setLiveWatch(!current);
      if (next?.error === "no_permission") {
        askEl.placeholder = next.needsSettings
          ? "Enable Screen Recording in System Settings, then reopen LYKN"
          : "Click Allow on the macOS Screen Recording dialog, then try again";
        const ph = askEl.placeholder;
        setTimeout(() => {
          if (askEl.placeholder === ph) {
            askEl.placeholder = COMPOSER_MODES[composerMode].placeholder;
          }
        }, 5000);
      }
      renderLiveWatchState(next);
    } catch (_) {}
  });
}

window.lyknOverlay.onLiveWatchUpdate((status) => {
  const prevRules = JSON.stringify(watchActiveRules);
  const prevSource = watchContextSource;
  const prevExt = watchExtensionConnected;
  handleLiveWatchCommentary(status);
  if (Array.isArray(status?.rules)) watchActiveRules = status.rules.slice();
  const rulesChanged = JSON.stringify(watchActiveRules) !== prevRules;
  const sourceChanged =
    (status?.contextSource && status.contextSource !== prevSource) ||
    (typeof status?.extensionConnected === "boolean" && status.extensionConnected !== prevExt);
  // Re-render when feed/rules/source change — not on every capture tick.
  if (status?.isNewCommentary || status?.enabled === false || rulesChanged || sourceChanged) {
    renderLiveWatchState(status);
  }
  if (liveWatchEnabled && voiceActive && voiceSessionToken && status?.summary) {
    void pushScreenContext(true);
  }
});

// ── Voice mode (ElevenLabs realtime agent) ─────────────────────────────────
const voiceEl = document.getElementById("voice");
const VOICE_TOOL_NAMES = [
  "search_vault", "read_document", "display_document", "web_search", "web_fetch",
  "find_connections", "get_beliefs", "get_rules", "get_facts", "propose_fact",
  "list_projects", "get_project_state", "set_active_project", "create_project",
  "update_project_state", "get_recent_activity", "create_reminder", "list_reminders",
  "update_reminder", "create_event", "list_events", "update_event", "delete_event",
  "create_todo", "list_todos", "update_todo", "delete_todo", "list_custom_models",
  "communicate_with_model", "build_with_cursor", "check_cursor_build", "save_to_vault",
  "save_link_to_vault", "add_to_project",
];
let voiceConvo = null;
let voiceActive = false;
let voiceStarting = false;
let voiceConnected = false;
let voiceAwaitingAnswer = false;
let voiceSessionToken = "";
// Monotonic token: every start/stop bumps it. Any async work from an older
// generation is stale and must not mutate UI or bring a session live. This is
// what keeps the on/off state honest when the user toggles mid-connect.
let voiceGen = 0;
let voiceConnectTimer = null;

function clearVoiceTimer() {
  if (voiceConnectTimer) {
    clearTimeout(voiceConnectTimer);
    voiceConnectTimer = null;
  }
}

// Voice turns start with the same thinking spinner as typed chat. When voice
// ends (or an answer lands), that spinner must be cleared — otherwise it keeps
// animating until the thread is wiped by a new chat.
function finalizeVoiceTurn({ removeEmpty = false } = {}) {
  voiceAwaitingAnswer = false;
  answerStillWorking = false;
  clearBuildingUnder();
  if (removeEmpty && currentAnswerEl && !currentHasText) {
    const chat = currentAnswerEl.closest(".chat");
    if (chat) chat.remove();
    currentAnswerEl = null;
    currentChatEl = null;
    currentQuestion = "";
    currentHasText = false;
    if (!threadEl.querySelector(".chat")) threadEl.classList.remove("show");
  }
  reportHeight();
}

// Feed the current screen to the live agent as contextual text, so voice mode
// "sees" the screen like the typed chat does. Throttled (vision calls are slow)
// and non-interrupting; the agent silently absorbs it for the next user turn.
let lastScreenPushAt = 0;
let screenPushInFlight = false;

async function pushScreenContext(force) {
  // Only needs the session token — we deliberately allow pushes during connect
  // so a fresh screen is already in the server grounding by the user's 1st turn.
  if (!voiceSessionToken) return;
  if (screenPushInFlight) return;
  const now = Date.now();
  // Live Watch already maintains a rolling summary — push more often (2s) since
  // main reuses it instead of running a fresh vision call each time.
  const minGap = liveWatchEnabled ? 2000 : 4000;
  if (!force && now - lastScreenPushAt < minGap) return;
  screenPushInFlight = true;
  lastScreenPushAt = now;
  try {
    // main captures + describes the screen and pushes it to the live session's
    // server-side grounding, so the custom-LLM injects it into every turn.
    await window.lyknOverlay.voiceScreen(voiceSessionToken);
  } catch (_) {
    /* ignore — screen context is best-effort */
  } finally {
    screenPushInFlight = false;
  }
}

function buildVoiceTools() {
  const tools = {};
  for (const name of VOICE_TOOL_NAMES) {
    tools[name] = async (params) => {
      try {
        const data = await window.lyknOverlay.voiceTool(name, params ?? {});
        return JSON.stringify(data);
      } catch (_) {
        return JSON.stringify({ ok: false, error: "tool_request_failed" });
      }
    };
  }
  // Local-only voice-instruction tuning isn't managed by the overlay; ack it.
  tools["update_voice_instructions"] = async () => JSON.stringify({ ok: true });
  return tools;
}

const voicePillEl = document.getElementById("voice-pill");

function setVoiceUi(state) {
  // state: 'connecting' | 'listening' | 'thinking' | 'speaking' | 'off'
  const on = state !== "off";
  const pillWasHidden = !voicePillEl || voicePillEl.hidden;
  voiceEl.classList.toggle("voice-active", on);
  micEl.classList.toggle("voice-active", on);
  if (voicePillEl) voicePillEl.hidden = !on;
  dotEl.classList.toggle("busy", on && state !== "listening");
  voiceEl.title = on ? "Stop voice mode" : "Voice mode";
  const voiceLabel = document.getElementById("voice-label");
  if (voiceLabel) voiceLabel.textContent = on ? "Stop voice mode" : "Voice mode";
  // Mic doubles as a stop button while voice is live (square icon via CSS).
  if (on) {
    micEl.title = "Stop voice mode";
    micEl.setAttribute("aria-label", "Stop voice mode");
    micEl.disabled = false;
  } else if (!recording && !transcribing) {
    micEl.title = "Dictate";
    micEl.setAttribute("aria-label", "Dictate");
  }
  // The composer stays ENABLED during voice — typed prompts/links route into
  // the live voice session via sendTextToVoice() instead of the streamed chat.
  askEl.disabled = false;
  if (on) {
    askEl.placeholder =
      state === "connecting"
        ? "Connecting voice…"
        : state === "speaking"
          ? "LYKN is speaking… type to chime in"
          : state === "thinking"
            ? "Thinking…"
            : "Listening… speak or type (Esc stops voice)";
  } else {
    askEl.placeholder = COMPOSER_MODES[composerMode].placeholder;
  }
  // Resize only when the Voice chip appears/disappears.
  if (pillWasHidden === on) reportHeight();
}

if (voicePillEl) {
  voicePillEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (voiceActive || voiceStarting) void stopVoice();
  });
}

function voiceUserMessage(text) {
  const t = String(text || "").trim();
  if (!t) return;
  startTurn(t);
  setThinkingStatus("Thinking…");
  voiceAwaitingAnswer = true;
}

// ── Typed messages into the live voice session ──────────────────────────────
// The composer stays usable during voice: ask() routes typed prompts here.
// The ElevenLabs SDK's sendUserMessage() delivers the text as a normal user
// turn, so the agent answers it out loud (and can run tools on it — fetch a
// pasted link, save it to the vault, etc.). We render the turn locally and
// suppress the transcript echo the server sends back for the same text.
let lastTypedVoiceText = "";
let lastTypedVoiceAt = 0;

function sendTextToVoice(text, atts) {
  if (!voiceConvo || typeof voiceConvo.sendUserMessage !== "function") {
    // Still connecting — keep the draft in the composer so nothing is lost.
    askEl.placeholder = "Voice is still connecting. Try again in a second…";
    return false;
  }
  const q = String(text || "").trim();
  const parts = [];
  if (q) parts.push(q);
  // Text attachments (files/snips with extracted text) ride along inline; the
  // voice LLM is text-only, so images are named rather than sent.
  for (const a of atts || []) {
    if (!a) continue;
    if (a.kind === "text" && a.text) {
      parts.push(`[Attached file "${a.name || "file"}"]\n${String(a.text).slice(0, 6000)}`);
    } else if (a.kind === "image") {
      parts.push(
        `[The user attached an image ("${a.name || "image"}"). Its pixels are not available in voice mode — ask them to describe it or to share it in the regular chat if you need its contents.]`,
      );
    }
  }
  if (!parts.length) return false;
  const message = parts.join("\n\n");
  try {
    voiceConvo.sendUserMessage(message);
  } catch (_) {
    voiceError("Couldn't send that to the voice agent. Try again.");
    return false;
  }
  lastTypedVoiceText = message;
  lastTypedVoiceAt = Date.now();
  const label = q || (atts && atts.length ? `Sent ${atts.length} attachment(s)` : message);
  voiceUserMessage(label);
  history.push({ role: "user", content: message, at: new Date().toISOString() });
  // Keep the server's screen grounding fresh for this turn (throttled).
  void pushScreenContext(false);
  return true;
}

function voiceAiMessage(text) {
  const t = String(text || "").trim();
  if (!t) return;
  if (!voiceAwaitingAnswer || !currentAnswerEl) startTurn("LYKN");
  updateAnswer(t);
  history.push({ role: "assistant", content: t, at: new Date().toISOString() });
  void persistCurrentSession();
  finalizeVoiceTurn();
}

function voiceError(message) {
  startTurn("Voice mode");
  updateAnswer(message);
  finalizeVoiceTurn();
  reportHeight();
}

async function startVoice() {
  if (voiceActive || voiceStarting) return;
  if (!window.ElevenLabsClient || !window.ElevenLabsClient.Conversation) {
    voiceError("Voice mode couldn't load. Try reopening LYKN.");
    return;
  }

  const myGen = ++voiceGen;
  // Stale if the user toggled voice off (or restarted it) while this async
  // start was still in flight. When stale we must never bring a session live.
  const cancelled = () => voiceGen !== myGen;

  voiceStarting = true;
  voiceActive = false;
  voiceConnected = false;
  setVoiceUi("connecting");

  // Watchdog: if we never reach a connected state, tear it all down instead of
  // showing "Connecting voice…" forever (e.g. WebRTC TURN resolution stalls).
  clearVoiceTimer();
  voiceConnectTimer = setTimeout(() => {
    if (cancelled() || voiceConnected) return;
    voiceGen += 1; // invalidate this attempt
    voiceStarting = false;
    voiceActive = false;
    const c = voiceConvo;
    voiceConvo = null;
    try { if (c && typeof c.endSession === "function") c.endSession(); } catch (_) {}
    setVoiceUi("off");
    finalizeVoiceTurn({ removeEmpty: true });
    voiceError("Voice connection timed out. Please try again.");
  }, 15000);

  const ok = await window.lyknOverlay.ensureMic();
  if (cancelled()) return;
  if (!ok) {
    clearVoiceTimer();
    voiceStarting = false;
    setVoiceUi("off");
    voiceError(
      "LYKN needs Microphone access. Enable it in System Settings → Privacy & Security → Microphone, then try again.",
    );
    return;
  }

  const timezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (_) {
      return null;
    }
  })();
  const screenInstructions =
    "You are LYKN running inside an on-screen overlay on the user's Mac, and you CAN see " +
    "the user's screen. The current screen contents are continuously provided to you as " +
    "contextual updates that start with \"SCREEN CONTENTS\". Treat those as your live view " +
    "of what is on the user's screen right now and use them to answer questions about what " +
    "they are looking at. Never tell the user you are unable to see or read their screen.";
  const data = await window.lyknOverlay.voiceSignedUrl({ instructions: screenInstructions, timezone });
  if (cancelled()) return;
  if (!data || data.error || (!data.conversationToken && !data.signedUrl)) {
    clearVoiceTimer();
    voiceStarting = false;
    setVoiceUi("off");
    voiceError((data && data.error) || "Couldn't start voice session.");
    return;
  }

  // Keep the session token so we can push screen context to the server grounding.
  voiceSessionToken = data.sessionToken || "";
  // Kick off the first screen push NOW (in parallel with the WebSocket connect +
  // the agent greeting) so the description — which takes ~2-3s — is already in
  // the server grounding by the time the user asks their first question.
  void pushScreenContext(true);

  const overrides = {};
  if (data.sessionToken) overrides.agent = { prompt: { prompt: `LYKN_SESSION_TOKEN=${data.sessionToken}` } };
  if (typeof data.firstMessage === "string" && data.firstMessage) {
    overrides.agent = Object.assign(overrides.agent || {}, { firstMessage: data.firstMessage });
  }

  const common = {
    clientTools: buildVoiceTools(),
    onConnect: () => {
      if (cancelled()) return;
      clearVoiceTimer();
      voiceConnected = true;
      voiceActive = true;
      voiceStarting = false;
      setVoiceUi("listening");
      // Prime the agent with the current screen right away.
      void pushScreenContext(true);
    },
    onDisconnect: () => {
      if (cancelled()) return;
      clearVoiceTimer();
      voiceActive = false;
      voiceStarting = false;
      voiceConnected = false;
      voiceConvo = null;
      voiceSessionToken = "";
      setVoiceUi("off");
      finalizeVoiceTurn({ removeEmpty: true });
    },
    onError: (e) => {
      if (cancelled()) return;
      clearVoiceTimer();
      const msg = (e && e.message) || (typeof e === "string" ? e : "Voice connection error.");
      voiceActive = false;
      voiceStarting = false;
      voiceConnected = false;
      voiceConvo = null;
      voiceSessionToken = "";
      setVoiceUi("off");
      finalizeVoiceTurn({ removeEmpty: true });
      voiceError(msg);
    },
    onModeChange: ({ mode }) => {
      if (cancelled()) return;
      setVoiceUi(mode === "speaking" ? "speaking" : "listening");
      // Returning to listening = the user is about to speak; refresh the screen
      // context (throttled) so their next question reflects what's on screen now.
      if (mode !== "speaking") void pushScreenContext(false);
    },
    onMessage: (m) => {
      if (cancelled()) return;
      const text = String((m && m.message) || "").trim();
      if (!text) return;
      if (m.source === "user") {
        // Typed messages are already rendered by sendTextToVoice(); skip the
        // transcript echo the server sends back for the same text.
        if (text === lastTypedVoiceText && Date.now() - lastTypedVoiceAt < 15000) return;
        voiceUserMessage(text);
        // Keep the server's screen grounding fresh for the next turn (throttled).
        void pushScreenContext(false);
      } else if (m.source === "ai") {
        voiceAiMessage(text);
      }
    },
    ...(Object.keys(overrides).length ? { overrides } : {}),
  };

  let convo = null;
  try {
    // Prefer the WebSocket transport: it connects fast and reliably. WebRTC is
    // nicer for audio jitter, but in this desktop environment its TURN server
    // (turn.rtc.elevenlabs.io) frequently fails to resolve and the connection
    // hangs, so we only fall back to it when no signed URL is available.
    if (data.signedUrl) {
      try {
        convo = await window.ElevenLabsClient.Conversation.startSession({
          ...common,
          signedUrl: data.signedUrl,
          connectionType: "websocket",
        });
      } catch (wsErr) {
        if (cancelled()) return;
        if (!data.conversationToken) throw wsErr;
        convo = await window.ElevenLabsClient.Conversation.startSession({
          ...common,
          conversationToken: data.conversationToken,
          connectionType: "webrtc",
        });
      }
    } else {
      convo = await window.ElevenLabsClient.Conversation.startSession({
        ...common,
        conversationToken: data.conversationToken,
        connectionType: "webrtc",
      });
    }
  } catch (e) {
    if (cancelled()) return;
    clearVoiceTimer();
    voiceStarting = false;
    voiceActive = false;
    voiceConnected = false;
    voiceConvo = null;
    setVoiceUi("off");
    voiceError((e && e.message) || "Couldn't start the voice connection.");
    return;
  }

  // The user toggled voice off while we were connecting: the session is now
  // live but unwanted, so tear it back down immediately.
  if (cancelled()) {
    try { if (convo && typeof convo.endSession === "function") await convo.endSession(); } catch (_) {}
    return;
  }
  voiceConvo = convo;
  voiceActive = true;
  voiceStarting = false;
  // onConnect may have fired before voiceConvo was assigned (so its push was a
  // no-op); now that the handle exists, prime the agent with the screen.
  void pushScreenContext(true);
}

async function stopVoice() {
  voiceGen += 1; // invalidate any in-flight start so it can't go live
  clearVoiceTimer();
  voiceStarting = false;
  voiceActive = false;
  voiceConnected = false;
  voiceSessionToken = "";
  const c = voiceConvo;
  voiceConvo = null;
  setVoiceUi("off");
  // Drop any in-flight "Thinking…" turn so the spinner doesn't keep running
  // after the user leaves voice mode.
  finalizeVoiceTurn({ removeEmpty: true });
  try {
    if (c && typeof c.endSession === "function") await c.endSession();
  } catch (_) {}
}

voiceEl.addEventListener("click", () => {
  if (voiceActive || voiceStarting) void stopVoice();
  else void startVoice();
});

// ── Shared Escape handling ─────────────────────────────────────────────────
// Priority: cancel drag → stop voice → close floating menus → stop listen →
// hide overlay. askEl used to "defer" voice-stop to a document listener and
// often did nothing; main also forwards Escape via before-input-event for
// macOS panel key-window quirks.
let escapeHandledAt = 0;

function isEscapeEvent(e) {
  return !!(e && (e.key === "Escape" || e.code === "Escape" || e.keyCode === 27));
}

function handleOverlayEscape(e) {
  const now = Date.now();
  // keydown + before-input IPC can both arrive for one keypress — run once so
  // we don't stop voice and then immediately hide the bar.
  if (now - escapeHandledAt < 300) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    return true;
  }

  if (overlayDragActive) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    for (const end of overlayDragEnders) {
      try {
        end();
      } catch (_) {}
    }
    return true;
  }

  if (voiceActive || voiceStarting) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    void stopVoice();
    return true;
  }

  if (moreUserOpen) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setMenuOpen(false);
    return true;
  }

  if (panelPickerOpen) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setPanelPickerOpen(false);
    return true;
  }

  if (translateLangPillEl && translateLangPillEl.classList.contains("open")) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      window.lyknOverlay.setLangPicker(false);
    } catch (_) {}
    translateLangPillEl.classList.remove("open");
    if (translateLangBtnEl) translateLangBtnEl.setAttribute("aria-expanded", "false");
    return true;
  }

  if (listening) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    stopListen();
    return true;
  }

  escapeHandledAt = now;
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  try {
    window.lyknOverlay.hide();
  } catch (_) {}
  return true;
}

window.addEventListener(
  "keydown",
  (e) => {
    if (!isEscapeEvent(e)) return;
    handleOverlayEscape(e);
  },
  true,
);

if (typeof window.lyknOverlay.onEscape === "function") {
  window.lyknOverlay.onEscape(() => handleOverlayEscape(null));
}

// ── Live listen: capture system (meeting) audio → rolling transcript ────────
// Uses getDisplayMedia with loopback audio (ScreenCaptureKit on macOS 13+, wired
// up in main via setDisplayMediaRequestHandler).
//
// Wispr-Flow-style pipeline: instead of fixed-length clips, a lightweight VAD
// (energy endpointing with an adaptive noise floor) cuts each recording at
// natural pauses — so words are never split mid-syllable and silence is never
// uploaded (no more hallucinated fragments, far fewer API calls). The raw ASR
// text is displayed the moment it arrives; LLM cleanup runs asynchronously and
// swaps the polished text in place, so cleanup latency never delays the
// transcript.
const listenEl = document.getElementById("listen");
const liveBodyEl = document.getElementById("live-body");
const liveDotEl = document.getElementById("live-dot");
const liveTitleEl = document.getElementById("live-title");
const notesSummaryEl = document.getElementById("notes-summary");
const notesTopicsEl = document.getElementById("notes-topics");
const notesKeyWrapEl = document.getElementById("notes-key-wrap");
const notesKeyEl = document.getElementById("notes-key");
const notesSuggestWrapEl = document.getElementById("notes-suggest-wrap");
const notesSuggestEl = document.getElementById("notes-suggest");
const notesActionsWrapEl = document.getElementById("notes-actions-wrap");
const notesActionsEl = document.getElementById("notes-actions");
const notesQuestionsEl = document.getElementById("notes-questions");
const notesQuestionsWrapEl = document.getElementById("notes-questions-wrap");
let listenDisplayStream = null;
let listenSysStream = null;
let listenMicStream = null;
// Per-speaker queues — mic and meeting audio transcribe in parallel.
const listenQueues = { them: Promise.resolve(), you: Promise.resolve() };
const listenTails = { them: "", you: "" };
const listenInterim = { them: null, you: null };
let listenStartedAt = 0;
let transcriptText = "";
// Every ASR utterance becomes a fragment so async LLM cleanup can swap the
// polished text in place after the raw text has already been shown.
let listenFragments = [];
let listenFragSeq = 0;
let notesTimer = null;
let notesInFlight = false;
let lastNotesLen = 0;
let lastNotesAt = 0;
const NOTES_INTERVAL_MS = 12000;
const SPEAKER_LABEL = { them: "Others", you: "You" };
const liveSaveBtn = document.getElementById("live-save");
const liveSavedToastEl = document.getElementById("live-saved-toast");
let meetingVaultSaved = false;
let meetingSaving = false;
let meetingSaveToastTimer = null;
let livePane = "notes";

// Push a render snapshot to the detached live notes card. The hidden #live
// DOM in this page stays the single source of truth (all the feature code
// below keeps writing into it); the floating window just mirrors its HTML.
function pushLiveState() {
  if (!liveNotesOpen) return;
  try {
    window.lyknOverlay.pushLive({
      listening,
      title: liveTitleEl.textContent,
      pane: livePane,
      notesHtml: document.getElementById("pane-notes").innerHTML,
      askHtml: document.getElementById("pane-ask").innerHTML,
      transcriptHtml: liveBodyEl.innerHTML,
      saveSaved: !!(liveSaveBtn && liveSaveBtn.classList.contains("saved")),
      saveDisabled: !!(liveSaveBtn && liveSaveBtn.disabled),
      toastText:
        liveSavedToastEl && !liveSavedToastEl.hidden ? liveSavedToastEl.textContent : "",
    });
  } catch (_) {}
}

// Remote control from the live card window — actions run HERE because this
// renderer owns the audio streams, transcript, and notes state.
window.__lyknLiveCmd = (name, arg) => {
  switch (name) {
    case "pane":
      switchLivePane(String(arg || "notes"));
      break;
    case "close":
      closeLive();
      break;
    case "copy":
      copyMeetingTranscript();
      break;
    case "save":
      void saveMeetingToVault({ force: true });
      break;
    case "vault":
      try {
        window.lyknOverlay.openVault?.();
      } catch (_) {}
      break;
    case "ask": {
      const q = String(arg || "").trim();
      if (q) {
        askEl.value = q;
        ask();
      }
      break;
    }
    case "url":
      try {
        const raw = arg;
        if (raw && typeof raw === "object") {
          window.lyknOverlay.openUrl(String(raw.url || ""), raw.title || undefined);
        } else {
          window.lyknOverlay.openUrl(String(raw || ""));
        }
      } catch (_) {}
      break;
  }
};

function formatMeetingDuration() {
  const ms = Math.max(0, Date.now() - (listenStartedAt || Date.now()));
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildMeetingTitle() {
  const topics = liveNotesSnapshot.topics || [];
  if (topics[0]) return `Meeting: ${topics[0]}`.slice(0, 120);
  const summary = String(liveNotesSnapshot.summary || "").trim();
  if (summary) {
    const first = summary.split(/[.!?]/)[0].trim();
    if (first.length >= 8) return first.slice(0, 120);
  }
  const d = new Date(listenStartedAt || Date.now());
  return `Meeting notes · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function buildMeetingVaultContent() {
  const snap = liveNotesSnapshot;
  const lines = [
    `# ${buildMeetingTitle()}`,
    "",
    `**Recorded:** ${new Date(listenStartedAt || Date.now()).toLocaleString()}`,
    `**Duration:** ${formatMeetingDuration()}`,
    "",
  ];
  if (snap.summary) {
    lines.push("## Summary", "", String(snap.summary).trim(), "");
  }
  if (snap.keyPoints?.length) {
    lines.push("## Key points", "");
    for (const p of snap.keyPoints) lines.push(`- ${String(p).trim()}`);
    lines.push("");
  }
  if (snap.actionItems?.length) {
    lines.push("## Action items", "");
    for (const p of snap.actionItems) lines.push(`- [ ] ${String(p).trim()}`);
    lines.push("");
  }
  if (snap.suggestions?.length) {
    lines.push("## Talking points", "");
    for (const p of snap.suggestions) lines.push(`- ${String(p).trim()}`);
    lines.push("");
  }
  if (snap.questionsToAsk?.length) {
    lines.push("## Questions to revisit", "");
    for (const p of snap.questionsToAsk) lines.push(`- ${String(p).trim()}`);
    lines.push("");
  }
  const txt = transcriptText.trim();
  if (txt) {
    lines.push("## Transcript", "", txt);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildMeetingCopyText() {
  const header = [
    buildMeetingTitle(),
    `Duration: ${formatMeetingDuration()}`,
    liveNotesSnapshot.summary ? `\nSummary:\n${liveNotesSnapshot.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = transcriptText.trim();
  return body ? `${header}\n\n---\n\n${body}` : header;
}

function showMeetingSavedToast(label = "Saved to Vault · Open in Vault →") {
  if (!liveSavedToastEl) return;
  liveSavedToastEl.textContent = label;
  liveSavedToastEl.hidden = false;
  if (liveSaveBtn) liveSaveBtn.classList.add("saved");
  if (meetingSaveToastTimer) clearTimeout(meetingSaveToastTimer);
  meetingSaveToastTimer = setTimeout(() => {
    if (liveSavedToastEl) liveSavedToastEl.hidden = true;
    pushLiveState();
  }, 12000);
  pushLiveState();
}

async function saveMeetingToVault({ auto = false, force = false } = {}) {
  if (meetingSaving || typeof window.lyknOverlay.saveVaultNote !== "function") return { ok: false };
  const txt = transcriptText.trim();
  if (txt.length < 40) {
    if (!auto) showMeetingSavedToast("Nothing to save yet");
    return { ok: false };
  }
  if (auto && meetingVaultSaved && !force) return { ok: false };

  meetingSaving = true;
  if (liveSaveBtn) liveSaveBtn.disabled = true;
  try {
    const content = buildMeetingVaultContent();
    const saved = await window.lyknOverlay.saveVaultNote({
      title: buildMeetingTitle(),
      content,
      tags: ["lykn-overlay", "meeting-notes"],
      folder: "Meetings",
      source: "meeting_notes",
    });
    if (saved?.ok) {
      meetingVaultSaved = true;
      showMeetingSavedToast(auto ? "Auto-saved to Vault · Open in Vault →" : "Saved to Vault · Open in Vault →");
      return { ok: true };
    }
    if (!auto) showMeetingSavedToast("Couldn't save. Sign in to LYKN");
  } catch (_) {
    if (!auto) showMeetingSavedToast("Couldn't save to Vault");
  } finally {
    meetingSaving = false;
    if (liveSaveBtn) liveSaveBtn.disabled = false;
    pushLiveState();
  }
  return { ok: false };
}

function copyMeetingTranscript() {
  const text = buildMeetingCopyText();
  if (!text.trim()) {
    showMeetingSavedToast("Nothing to copy yet");
    return;
  }
  try {
    window.lyknOverlay.copyText?.(text);
    showMeetingSavedToast("Transcript copied");
  } catch (_) {}
}

function formatListenTime(ms) {
  const sec = Math.max(0, Math.floor((ms - listenStartedAt) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function setSpeakerTranscribing(speaker, active) {
  if (active) {
    if (listenInterim[speaker]) return;
    const line = document.createElement("div");
    line.className = `live-line ${speaker} transcribing`;
    line.dataset.speaker = speaker;
    line.dataset.interim = "1";
    const time = document.createElement("span");
    time.className = "live-time";
    time.textContent = formatListenTime(Date.now());
    const lab = document.createElement("span");
    lab.className = "live-speaker";
    lab.textContent = SPEAKER_LABEL[speaker];
    const body = document.createElement("span");
    body.className = "live-text";
    body.textContent = "…";
    line.append(time, lab, body);
    liveBodyEl.appendChild(line);
    listenInterim[speaker] = line;
    liveBodyEl.scrollTop = liveBodyEl.scrollHeight;
    pushLiveState();
  } else if (listenInterim[speaker]) {
    listenInterim[speaker].remove();
    listenInterim[speaker] = null;
    pushLiveState();
  }
}

// The "…" indicator shows from the moment the VAD hears speech until the last
// in-flight utterance for that speaker has been transcribed.
function updateSpeakerInterim(speaker) {
  setSpeakerTranscribing(speaker, !!vadActive[speaker] || listenPending[speaker] > 0);
}

function setListenUi() {
  listenEl.classList.toggle("listening", listening);
  listenEl.title = listening ? "Stop transcribe" : "Transcribe";
  const listenLabel = document.getElementById("listen-label");
  if (listenLabel) listenLabel.textContent = listening ? "Stop transcribe" : "Transcribe";
  liveDotEl.classList.toggle("live", listening);
  liveTitleEl.textContent = listening ? "Transcribe · live" : "Transcript";
  renderModeBadge("transcribe-state", listening || composerMode === "transcribe");
  // Keep composer mode / pill in sync when capture starts/stops outside the menu.
  if (!syncingTranscribeMode) {
    if (listening && composerMode !== "transcribe") {
      syncingTranscribeMode = true;
      try {
        setComposerMode("transcribe");
      } finally {
        syncingTranscribeMode = false;
      }
    } else if (!listening && composerMode === "transcribe") {
      syncingTranscribeMode = true;
      try {
        setComposerMode("chat");
      } finally {
        syncingTranscribeMode = false;
      }
    }
  }
  pushLiveState();
}

function switchLivePane(pane) {
  livePane = pane;
  pushLiveState();
}

function renderMeetingQuestion(q) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "meeting-question";
  const ico = document.createElement("span");
  ico.className = "meeting-question-ico";
  ico.innerHTML = ARROW_ICON_SVG;
  const span = document.createElement("span");
  span.textContent = String(q);
  btn.append(ico, span);
  btn.addEventListener("click", () => {
    askEl.value = String(q);
    ask();
  });
  li.appendChild(btn);
  return li;
}

function renderNotes(notes) {
  if (!notes) return;
  notesSummaryEl.textContent = String(notes.summary || "");
  const fill = (listEl, wrapEl, items) => {
    listEl.innerHTML = "";
    const arr = Array.isArray(items) ? items.filter(Boolean) : [];
    for (const it of arr) {
      const li = document.createElement("li");
      li.textContent = String(it);
      listEl.appendChild(li);
    }
    if (wrapEl) wrapEl.hidden = arr.length === 0;
  };
  fill(notesKeyEl, notesKeyWrapEl, notes.keyPoints);
  fill(notesSuggestEl, notesSuggestWrapEl, notes.suggestions);
  fill(notesActionsEl, notesActionsWrapEl, notes.actionItems);

  notesQuestionsEl.innerHTML = "";
  const questions = Array.isArray(notes.questionsToAsk) ? notes.questionsToAsk.filter(Boolean) : [];
  for (const q of questions) notesQuestionsEl.appendChild(renderMeetingQuestion(q));
  if (notesQuestionsWrapEl) {
    notesQuestionsWrapEl.hidden = questions.length === 0;
  }

  notesTopicsEl.innerHTML = "";
  const topics = Array.isArray(notes.topics) ? notes.topics.filter(Boolean) : [];
  for (const t of topics) {
    const chip = document.createElement("span");
    chip.className = "notes-topic";
    chip.textContent = String(t);
    notesTopicsEl.appendChild(chip);
  }
  notesTopicsEl.hidden = topics.length === 0;
  pushLiveState();

  liveNotesSnapshot = {
    keyPoints: Array.isArray(notes.keyPoints) ? notes.keyPoints.filter(Boolean) : [],
    actionItems: Array.isArray(notes.actionItems) ? notes.actionItems.filter(Boolean) : [],
    summary: String(notes.summary || "").trim(),
    questionsToAsk: questions,
    suggestions: Array.isArray(notes.suggestions) ? notes.suggestions.filter(Boolean) : [],
    topics,
  };
  refreshSidePanelFromLiveNotes();
  reportHeight();
}

async function refreshNotes(force = false) {
  if (notesInFlight) return;
  const txt = transcriptText.trim();
  if (txt.length < 40) return;
  const now = Date.now();
  const grew = txt.length - lastNotesLen >= 50;
  const due = now - lastNotesAt >= NOTES_INTERVAL_MS;
  if (!force && !grew && !due) return;
  notesInFlight = true;
  lastNotesLen = txt.length;
  lastNotesAt = now;
  try {
    const prev = liveNotesSnapshot.summary
      ? {
          summary: liveNotesSnapshot.summary,
          keyPoints: liveNotesSnapshot.keyPoints,
          actionItems: liveNotesSnapshot.actionItems,
        }
      : null;
    const notes = await window.lyknOverlay.meetingNotes(txt, prev);
    if (
      notes &&
      (notes.summary ||
        notes.keyPoints?.length ||
        notes.actionItems?.length ||
        notes.questionsToAsk?.length ||
        notes.suggestions?.length)
    ) {
      renderNotes(notes);
    }
  } catch (_) {}
  notesInFlight = false;
}

// Rebuild the flat transcript (used for notes / vault / copy) from fragments,
// merging consecutive same-speaker utterances into one line.
function rebuildTranscriptText() {
  const parts = [];
  let curSpeaker = null;
  let cur = [];
  for (const f of listenFragments) {
    if (f.speaker !== curSpeaker) {
      if (cur.length) parts.push(`${SPEAKER_LABEL[curSpeaker] || curSpeaker}: ${cur.join(" ")}`);
      curSpeaker = f.speaker;
      cur = [];
    }
    cur.push(f.text);
  }
  if (cur.length) parts.push(`${SPEAKER_LABEL[curSpeaker] || curSpeaker}: ${cur.join(" ")}`);
  transcriptText = parts.length ? `${parts.join("\n")}\n` : "";
}

// ── Live assist (Cluely-style in-call copilot) ──────────────────────────────
// After each utterance settles, the rolling transcript is sent to the backend,
// which decides whether THIS moment deserves a private help card — an answer
// to a question the user was just asked, a quick brief on a company/term that
// came up, a fact check, or a suggested next line — optionally composed from
// a live web search run mid-sentence. Cards land at the top of the Notes pane
// in the floating live window. Silence is the default; cards must feel earned.
const assistFeedEl = document.getElementById("assist-feed");
const ASSIST_DEBOUNCE_MS = 1200; // let the sentence settle before asking
const ASSIST_MIN_INTERVAL_MS = 6000; // never ping the backend faster than this
const ASSIST_MAX_CARDS = 6;
const ASSIST_KIND_LABEL = {
  answer: "Answer",
  brief: "Brief",
  fact: "Fact check",
  suggest: "Say this",
};
let assistShownTitles = [];
let assistInFlight = false;
let assistTimer = null;
let assistLastRanAt = 0;
let assistLastLen = 0;

function scheduleLiveAssist() {
  if (!listening) return;
  if (assistTimer) clearTimeout(assistTimer);
  const wait = Math.max(
    ASSIST_DEBOUNCE_MS,
    ASSIST_MIN_INTERVAL_MS - (Date.now() - assistLastRanAt),
  );
  assistTimer = setTimeout(() => {
    assistTimer = null;
    void runLiveAssist();
  }, wait);
}

async function runLiveAssist() {
  if (!listening || assistInFlight) return;
  const txt = transcriptText.trim();
  // Need real new content since the last look — not just a stray word.
  if (txt.length < 60 || txt.length - assistLastLen < 24) return;
  assistInFlight = true;
  assistLastRanAt = Date.now();
  assistLastLen = txt.length;
  try {
    const r = await window.lyknOverlay.liveAssist(txt.slice(-2400), assistShownTitles);
    const insight = r && r.insight;
    if (insight && insight.body && listening) addAssistCard(insight);
  } catch (_) {}
  assistInFlight = false;
}

function addAssistCard(insight) {
  const kind = ASSIST_KIND_LABEL[insight.kind] ? insight.kind : "suggest";
  const title = String(insight.title || "").trim() || "Heads up";
  assistShownTitles.push(title);
  assistShownTitles = assistShownTitles.slice(-12);

  const card = document.createElement("div");
  card.className = `assist-card kind-${kind}`;
  const head = document.createElement("div");
  head.className = "assist-head";
  const kindEl = document.createElement("span");
  kindEl.className = "assist-kind";
  kindEl.textContent = ASSIST_KIND_LABEL[kind];
  const titleEl = document.createElement("span");
  titleEl.className = "assist-title";
  titleEl.textContent = title;
  head.append(kindEl, titleEl);
  const body = document.createElement("div");
  body.className = "assist-body";
  body.textContent = String(insight.body || "").trim();
  card.append(head, body);

  const sources = Array.isArray(insight.sources) ? insight.sources.filter((s) => s && s.url) : [];
  if (sources.length) {
    const row = document.createElement("div");
    row.className = "assist-sources";
    for (const s of sources.slice(0, 3)) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "assist-src";
      link.dataset.url = s.url;
      if (s.title) link.dataset.title = s.title;
      link.addEventListener("click", () => {
        window.lyknOverlay.openUrl(s.url, s.title || undefined);
      });
      try {
        link.textContent = new URL(s.url).hostname.replace(/^www\./, "");
      } catch (_) {
        link.textContent = "source";
      }
      row.appendChild(link);
    }
    card.appendChild(row);
  }

  assistFeedEl.prepend(card);
  while (assistFeedEl.children.length > ASSIST_MAX_CARDS) assistFeedEl.lastChild.remove();
  // Surface the card: flip the live window to the Suggestions pane so the
  // help is actually seen the moment it lands.
  if (livePane !== "ask") switchLivePane("ask");
  else pushLiveState();
}

// ── Junk suppression ────────────────────────────────────────────────────────
// Three classes of garbage never reach the transcript:
//  1. ASR artifacts — stock phrases speech models emit on music/noise.
//  2. Echo duplicates — without headphones the mic re-hears the meeting audio,
//     so "You" would repeat what "Others" just said (and vice versa).
//  3. Stuck repeats — the same utterance recognized twice back-to-back.
function normalizeUtterance(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Conservative list: only phrases that are near-certain hallucinations when
// they arrive as a WHOLE standalone utterance (classic YouTube-outro junk).
const ASR_ARTIFACTS = new Set([
  "you",
  "bye",
  "thanks for watching",
  "thank you for watching",
  "thank you so much for watching",
  "please subscribe",
  "like and subscribe",
  "don't forget to subscribe",
  "see you in the next video",
  "see you next time",
  "subtitles by the amara org community",
]);

const lastUtter = { them: { norm: "", at: 0 }, you: { norm: "", at: 0 } };

function isJunkUtterance(speaker, norm) {
  if (!norm) return true;
  if (ASR_ARTIFACTS.has(norm)) return true;
  const now = Date.now();
  // Stuck repeat from the same speaker.
  const mine = lastUtter[speaker];
  if (mine.norm && norm === mine.norm && now - mine.at < 6000) return true;
  // Speaker echo: the new utterance is (a piece of) what the other source
  // just heard. Only the CONTAINED direction is an echo — a longer utterance
  // that merely includes the other's text is new speech and must be kept.
  const other = lastUtter[speaker === "you" ? "them" : "you"];
  if (other.norm && now - other.at < 6000) {
    if (norm === other.norm) return true;
    if (norm.length > 12 && other.norm.includes(norm)) return true;
  }
  return false;
}

// Show the raw ASR text IMMEDIATELY (Wispr-Flow-style: never make the user
// wait on the polish), keyed by fragment id so the async LLM cleanup below
// can swap the corrected text in place.
function appendUtterance(speaker, text) {
  const t = String(text || "").trim();
  if (!t) return;
  const norm = normalizeUtterance(t);
  if (isJunkUtterance(speaker, norm)) return;
  lastUtter[speaker] = { norm, at: Date.now() };
  const frag = { id: String(++listenFragSeq), speaker, text: t };
  listenFragments.push(frag);

  const span = document.createElement("span");
  span.className = "live-frag";
  span.dataset.frag = frag.id;
  span.textContent = t;

  const last = liveBodyEl.lastElementChild;
  if (last && last.dataset.speaker === speaker && !last.dataset.interim) {
    const body = last.querySelector(".live-text");
    body.append(document.createTextNode(" "), span);
  } else {
    const line = document.createElement("div");
    line.className = `live-line ${speaker}`;
    line.dataset.speaker = speaker;
    const time = document.createElement("span");
    time.className = "live-time";
    time.textContent = formatListenTime(Date.now());
    const lab = document.createElement("span");
    lab.className = "live-speaker";
    lab.textContent = SPEAKER_LABEL[speaker] || speaker;
    const body = document.createElement("span");
    body.className = "live-text";
    body.appendChild(span);
    line.append(time, lab, body);
    liveBodyEl.appendChild(line);
  }

  listenTails[speaker] = `${listenTails[speaker] ? `${listenTails[speaker]} ` : ""}${t}`
    .split(/\s+/)
    .slice(-50)
    .join(" ");
  rebuildTranscriptText();
  liveBodyEl.scrollTop = liveBodyEl.scrollHeight;
  void refreshNotes();
  scheduleLiveAssist();
  pushLiveState();
  void cleanFragment(frag);
}

// Drop a fragment entirely (the cleanup model judged it pure filler): remove
// its span, and the whole line if nothing else is left on it.
function removeFragment(frag) {
  const i = listenFragments.indexOf(frag);
  if (i >= 0) listenFragments.splice(i, 1);
  const span = liveBodyEl.querySelector(`.live-frag[data-frag="${frag.id}"]`);
  if (span) {
    const line = span.closest(".live-line");
    const body = span.closest(".live-text");
    const prev = span.previousSibling;
    if (prev && prev.nodeType === Node.TEXT_NODE) prev.remove();
    span.remove();
    if (line && body && !body.querySelector(".live-frag")) line.remove();
  }
  rebuildTranscriptText();
  pushLiveState();
}

// Async polish pass — strips fillers/stutters and fixes punctuation, then
// swaps the fragment in place. Fails open: the raw text simply stays.
async function cleanFragment(frag) {
  // Nothing worth polishing (and one less LLM round trip) on tiny fragments.
  if (frag.text.length < 14) return;
  const idx = listenFragments.indexOf(frag);
  const context = listenFragments
    .slice(Math.max(0, idx - 4), idx)
    .map((f) => f.text)
    .join(" ")
    .slice(-500);
  let cleaned = null;
  try {
    const r = await window.lyknOverlay.cleanTranscript(frag.text, context);
    cleaned = r && typeof r.text === "string" ? r.text.trim() : null;
  } catch (_) {}
  if (cleaned == null) return; // request failed — keep raw
  if (!cleaned) {
    // The model deemed it pure filler. Only trust that for very short
    // fragments — never let it blank out a real sentence.
    if (frag.text.length < 24 && listenFragments.includes(frag)) removeFragment(frag);
    return;
  }
  if (cleaned === frag.text) return;
  frag.text = cleaned;
  const span = liveBodyEl.querySelector(`.live-frag[data-frag="${frag.id}"]`);
  if (span) span.textContent = cleaned;
  rebuildTranscriptText();
  pushLiveState();
}

async function processUtterance(wavBuf, speaker) {
  if (!listening) return;
  let text = "";
  let noSpeech = 0;
  try {
    const r = await window.lyknOverlay.meetingChunk(
      wavBuf,
      "audio/wav",
      listenTails[speaker],
      listenTails[speaker],
    );
    text = r && r.text ? r.text.trim() : "";
    noSpeech = r && typeof r.noSpeech === "number" ? r.noSpeech : 0;
  } catch (_) {}
  listenPending[speaker] = Math.max(0, listenPending[speaker] - 1);
  updateSpeakerInterim(speaker);
  if (!text || noSpeech > 0.72 || !listening) return;
  appendUtterance(speaker, text);
}

// ── VAD capture — continuous PCM with energy endpointing ────────────────────
// Instead of blind fixed-length clips (which split words mid-syllable and
// upload silence), we tap raw PCM off each stream and cut utterances at
// natural pauses: an adaptive noise floor decides when speech starts, a short
// hangover decides when it ended, and a pre-roll ring keeps the first
// syllable intact. Only actual speech ever reaches the ASR API.
const LISTEN_SAMPLE_RATE = 16000;
const VAD_FRAME_MS = 128; // ScriptProcessor buffer of 2048 samples @ 16k
const VAD_HANG_MS = 450; // silence needed to close an utterance
// A single frame of clear speech is enough to keep an utterance — RMS gating
// undercounts soft speech, so a stricter gate silently dropped short words
// ("No.", "Sure.") and quiet sentence starts.
const VAD_MIN_SPEECH_MS = 150;
const VAD_PRE_ROLL_MS = 480; // audio kept from before speech onset
const VAD_MAX_UTTER_MS = 8000; // prefer a cut past this, at the next soft frame
const VAD_HARD_MAX_UTTER_MS = 12000; // …but never run longer than this
const vadActive = { them: false, you: false };
const listenPending = { them: 0, you: 0 };
let listenAudioCtx = null;
let listenTaps = [];

// 16-bit mono WAV — tiny header + PCM, cheapest reliable container for API upload.
function encodeWav(float32, sampleRate) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

function tapStreamWithVad(stream, speaker) {
  if (!listening || !stream || !listenAudioCtx) return;
  let source;
  try {
    source = listenAudioCtx.createMediaStreamSource(stream);
  } catch (_) {
    return;
  }
  const proc = listenAudioCtx.createScriptProcessor(2048, 1, 1);
  // Keep the node alive without feeding audio anywhere audible.
  const sink = listenAudioCtx.createGain();
  sink.gain.value = 0;

  const framesPerMs = listenAudioCtx.sampleRate / 1000;
  const preRollFrames = Math.ceil((VAD_PRE_ROLL_MS * framesPerMs) / 2048);
  const hangFrames = Math.ceil((VAD_HANG_MS * framesPerMs) / 2048);
  const preRoll = [];
  let utterance = [];
  let speechMs = 0;
  let silentFrames = 0;
  let utterMs = 0;
  // Adaptive noise floor: EMA of frame RMS while not speaking. Seeded high so
  // the first frames don't trigger; converges within ~a second.
  let noiseFloor = 0.02;

  const finalize = (force) => {
    const hadSpeech = speechMs >= VAD_MIN_SPEECH_MS;
    const chunks = utterance;
    utterance = [];
    speechMs = 0;
    silentFrames = 0;
    utterMs = 0;
    vadActive[speaker] = false;
    if (!hadSpeech || !chunks.length) {
      updateSpeakerInterim(speaker);
      return;
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const joined = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      joined.set(c, off);
      off += c.length;
    }
    const wav = encodeWav(joined, listenAudioCtx.sampleRate);
    listenPending[speaker] += 1;
    updateSpeakerInterim(speaker);
    listenQueues[speaker] = listenQueues[speaker]
      .then(() => processUtterance(wav, speaker))
      .catch(() => {});
    if (force) {
      // Forced mid-speech cut: stay "active" so capture continues seamlessly.
      vadActive[speaker] = true;
    }
  };

  proc.onaudioprocess = (e) => {
    if (!listening) return;
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    // 2.0× floor (was 2.5×) with a lower absolute minimum — quiet speakers
    // and soft sentence onsets were sitting just under the old trigger.
    const threshold = Math.max(0.0045, noiseFloor * 2.0);
    const frame = new Float32Array(data); // copy — the buffer is reused

    if (!vadActive[speaker]) {
      // Idle: learn the noise floor, keep a pre-roll ring.
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      preRoll.push(frame);
      if (preRoll.length > preRollFrames) preRoll.shift();
      if (rms > threshold) {
        vadActive[speaker] = true;
        utterance = preRoll.splice(0, preRoll.length);
        utterance.push(frame);
        speechMs = VAD_FRAME_MS;
        silentFrames = 0;
        utterMs = utterance.length * VAD_FRAME_MS;
        updateSpeakerInterim(speaker);
      }
      return;
    }

    // In an utterance: keep capturing through short pauses.
    utterance.push(frame);
    utterMs += VAD_FRAME_MS;
    if (rms > threshold) {
      speechMs += VAD_FRAME_MS;
      silentFrames = 0;
    } else {
      silentFrames += 1;
      // Silence keeps refining the floor so the threshold tracks room tone.
      noiseFloor = noiseFloor * 0.98 + rms * 0.02;
    }
    if (silentFrames >= hangFrames) {
      // Keep the full hangover tail — trailing fricatives and soft word
      // endings read as "silence" to an RMS gate, and trimming them was
      // clipping the last word. 450ms of extra audio costs nothing.
      finalize(false);
    } else if (utterMs >= VAD_MAX_UTTER_MS && silentFrames > 0) {
      // Past the soft cap: cut at the first below-threshold frame so the cut
      // lands between words instead of mid-syllable.
      finalize(true);
    } else if (utterMs >= VAD_HARD_MAX_UTTER_MS) {
      finalize(true);
    }
  };

  source.connect(proc);
  proc.connect(sink);
  sink.connect(listenAudioCtx.destination);
  listenTaps.push({ source, proc, sink });
}

function teardownListenTaps() {
  for (const t of listenTaps) {
    try { t.proc.onaudioprocess = null; } catch (_) {}
    try { t.source.disconnect(); } catch (_) {}
    try { t.proc.disconnect(); } catch (_) {}
    try { t.sink.disconnect(); } catch (_) {}
  }
  listenTaps = [];
  if (listenAudioCtx) {
    try { void listenAudioCtx.close(); } catch (_) {}
    listenAudioCtx = null;
  }
  vadActive.them = false;
  vadActive.you = false;
  listenPending.them = 0;
  listenPending.you = 0;
}

async function startListen() {
  if (listening) return;
  // Order matters for macOS Allow dialogs: system-audio / Screen Recording first,
  // then Microphone — never ask for both at once.
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (_) {
    startTurn("Transcribe");
    const isWin = window.lyknOverlay?.platform === "win32";
    updateAnswer(
      isWin
        ? "LYKN couldn't start system-audio capture. Make sure nothing is blocking screen capture, then try Transcribe again."
        : "LYKN needs Screen Recording permission to capture system audio. Enable it in System Settings → Privacy & Security → Screen Recording, then try again.",
    );
    reportHeight();
    return;
  }
  const sysTracks = display.getAudioTracks();
  if (!sysTracks.length) {
    try { display.getTracks().forEach((t) => t.stop()); } catch (_) {}
    startTurn("Transcribe");
    const isWin = window.lyknOverlay?.platform === "win32";
    updateAnswer(
      isWin
        ? "Couldn't capture system audio. On Windows this uses loopback capture — try again, or restart LYKN if it still fails."
        : "Couldn't capture system audio. This needs macOS 13 (Ventura) or newer.",
    );
    reportHeight();
    return;
  }
  let micStream = null;
  try {
    const ok = await window.lyknOverlay.ensureMic();
    if (ok) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
  } catch (_) {
    micStream = null;
  }

  listenDisplayStream = display;
  listenSysStream = new MediaStream(sysTracks);
  listenMicStream = micStream;
  listenTails.them = "";
  listenTails.you = "";
  listenQueues.them = Promise.resolve();
  listenQueues.you = Promise.resolve();
  listenInterim.them = null;
  listenInterim.you = null;
  listenStartedAt = Date.now();
  transcriptText = "";
  listenFragments = [];
  listenFragSeq = 0;
  lastUtter.them = { norm: "", at: 0 };
  lastUtter.you = { norm: "", at: 0 };
  assistFeedEl.innerHTML = "";
  assistShownTitles = [];
  assistLastRanAt = 0;
  assistLastLen = 0;
  lastNotesLen = 0;
  lastNotesAt = 0;
  meetingVaultSaved = false;
  meetingSaving = false;
  if (liveSaveBtn) {
    liveSaveBtn.classList.remove("saved");
    liveSaveBtn.disabled = false;
  }
  if (liveSavedToastEl) liveSavedToastEl.hidden = true;
  liveBodyEl.innerHTML = "";
  notesSummaryEl.textContent = "";
  notesTopicsEl.innerHTML = "";
  notesTopicsEl.hidden = true;
  notesKeyEl.innerHTML = "";
  notesSuggestEl.innerHTML = "";
  notesActionsEl.innerHTML = "";
  notesQuestionsEl.innerHTML = "";
  notesKeyWrapEl.hidden = true;
  notesSuggestWrapEl.hidden = true;
  notesActionsWrapEl.hidden = true;
  if (notesQuestionsWrapEl) notesQuestionsWrapEl.hidden = true;
  liveNotesSnapshot = {
    keyPoints: [],
    actionItems: [],
    summary: "",
    questionsToAsk: [],
    suggestions: [],
    topics: [],
  };
  listening = true;
  applyLiveNotesLayout(true);
  switchLivePane("notes");
  setListenUi();
  if (notesTimer) clearInterval(notesTimer);
  notesTimer = setInterval(() => void refreshNotes(true), NOTES_INTERVAL_MS);
  setTimeout(() => {
    if (listening) void refreshNotes(true);
  }, 5000);
  sysTracks[0].addEventListener("ended", () => {
    if (listening) stopListen();
  });
  // Continuous PCM taps with VAD endpointing — 16 kHz mono is exactly what
  // Whisper ingests, and resampling here keeps upload sizes small.
  try {
    listenAudioCtx = new AudioContext({ sampleRate: LISTEN_SAMPLE_RATE });
  } catch (_) {
    listenAudioCtx = new AudioContext();
  }
  tapStreamWithVad(listenSysStream, "them");
  if (listenMicStream) tapStreamWithVad(listenMicStream, "you");
}

function stopListen() {
  listening = false;
  teardownListenTaps();
  setSpeakerTranscribing("them", false);
  setSpeakerTranscribing("you", false);
  if (assistTimer) {
    clearTimeout(assistTimer);
    assistTimer = null;
  }
  if (notesTimer) {
    clearInterval(notesTimer);
    notesTimer = null;
  }
  try {
    listenDisplayStream && listenDisplayStream.getTracks().forEach((t) => t.stop());
  } catch (_) {}
  try {
    listenMicStream && listenMicStream.getTracks().forEach((t) => t.stop());
  } catch (_) {}
  listenDisplayStream = null;
  listenSysStream = null;
  listenMicStream = null;
  setListenUi();
  void (async () => {
    await refreshNotes(true);
    await saveMeetingToVault({ auto: true });
  })();
}

function closeLive() {
  if (listening) stopListen();
  applyLiveNotesLayout(false);
}

listenEl.addEventListener("click", () => {
  // Hidden drawer control — same toggle as Transcribe mode.
  if (listening || composerMode === "transcribe") setComposerMode("chat");
  else setComposerMode("transcribe");
});
// The card's own controls (tabs, close, copy, save, toast) live in the
// detached window and arrive as commands via window.__lyknLiveCmd above.

// NOTE: In Electron, file drop/dragover events frequently won't fire unless a
// dragover listener is registered on `document` (a long-standing quirk). We bind
// to document, window, and body, and always preventDefault so the OS doesn't just
// open the file. On macOS the overlay is a non-activating `panel` window, which
// the OS won't route external file drops to — there the in-bar attach button is
// the reliable path. These handlers still serve platforms where drops work.
let dragDepth = 0;
const onDragEnter = (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth += 1;
  wrapEl.classList.add("dropping");
};
const onDragOver = (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
};
const onDragLeave = (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) wrapEl.classList.remove("dropping");
};
const onDrop = (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  wrapEl.classList.remove("dropping");
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length) {
    void addFiles(dt.files);
    return;
  }
  // Fallback: some platforms populate items but not files until accessed.
  if (dt && dt.items && dt.items.length) {
    const files = [];
    for (const item of dt.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) void addFiles(files);
  }
};
for (const target of [document, window, document.body]) {
  if (!target) continue;
  target.addEventListener("dragenter", onDragEnter);
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("dragleave", onDragLeave);
  target.addEventListener("drop", onDrop);
}

sendEl.addEventListener("click", ask);
// Grow the prompt field to fit its content (capped by CSS max-height, after
// which it scrolls), then report the new size so the window grows with it.
function autoGrowAsk() {
  askEl.style.height = "auto";
  askEl.style.height = Math.min(askEl.scrollHeight, 180) + "px";
  reportHeight();
}

askEl.addEventListener("input", autoGrowAsk);

askEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    // Enter sends; Shift+Enter inserts a newline (handled by default).
    e.preventDefault();
    ask();
  } else if (isEscapeEvent(e)) {
    // Capture-phase handler also runs; this keeps Esc reliable when focus is
    // in the composer (the common case during voice).
    handleOverlayEscape(e);
  }
});

askEl.focus();
syncSidePickerState();
reportHeight();

void (async () => {
  try {
    const res = await window.lyknOverlay.ensureOverlaySession();
    if (res && res.sessionId) currentSessionId = res.sessionId;
  } catch (_) {}
})();
