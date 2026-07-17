/** Night Shift morning brief helpers (Phase 0). */

export const MORNING_BRIEF_STATE_KEY = "morning_brief";

/** Briefs older than this are treated as stale (overlay + hero cards). */
export const MORNING_BRIEF_MAX_AGE_MS = 20 * 60 * 60 * 1000;

/**
 * @param {Array<{ stateKey: string, value?: string, setAt?: number, setByClient?: string|null, id?: string }>} updates
 */
export function findMorningBrief(updates) {
  if (!Array.isArray(updates)) return null;
  return updates.find((u) => u.stateKey === MORNING_BRIEF_STATE_KEY) || null;
}

/**
 * @param {{ setAt?: number } | null | undefined} brief
 * @param {number} [maxAgeMs]
 */
export function isFreshMorningBrief(brief, maxAgeMs = MORNING_BRIEF_MAX_AGE_MS) {
  if (!brief?.setAt) return false;
  return Date.now() - brief.setAt < maxAgeMs;
}

/**
 * Minimal inline Markdown → HTML for morning brief display.
 * @param {string} md
 */
export function renderMorningBriefHtml(md) {
  const escape = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const lines = escape(md || "").split("\n");
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      html += `<div class="mb-1 font-semibold">${h[1]}</div>`;
      continue;
    }
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!inList) {
        html += "<ul class='list-disc pl-4 space-y-0.5'>";
        inList = true;
      }
      html += `<li>${bullet[1]}</li>`;
      continue;
    }
    closeList();
    html += `<p class="mb-1">${line}</p>`;
  }
  closeList();
  return html;
}

/**
 * @param {Array<{ id?: string, setAt?: string|number }>} briefs
 */
export function nightBriefDismissKey(briefs) {
  if (!Array.isArray(briefs) || !briefs.length) return "";
  return briefs
    .map((b) => `${b.id || ""}:${b.setAt || ""}`)
    .sort()
    .join("|");
}
