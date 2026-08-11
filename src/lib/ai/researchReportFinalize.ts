/**
 * Research-mode reports emit stock/chart/sheet as fenced blocks. When a
 * stream is cut mid-fence, react-markdown treats the rest of the reply as a
 * code block and the embed renderer falls back to raw JSON. These helpers
 * repair salvageable JSON or strip unclosed research fences before commit.
 */

const RESEARCH_FENCE_LANG_RE = /^(stock|chart|sheet|spreadsheet|csv)\b/i;

/** Best-effort repair for truncated chart/sheet JSON objects/arrays. */
export function tryRepairJsonText(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    JSON.parse(s);
    return s;
  } catch {
    /* fall through */
  }

  let t = s
    // Unfinished key / value string after a comma.
    .replace(/,\s*"[^"]*$/u, "")
    .replace(/,\s*"[^"]*"\s*:\s*$/u, "")
    .replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/u, "")
    // Unfinished bare identifier (not a number) after a comma.
    .replace(/,\s*[A-Za-z_][A-Za-z0-9_]*$/u, "")
    .replace(/:\s*$/u, "")
    .replace(/,\s*$/u, "");

  // Balance braces/brackets outside of strings.
  let inString = false;
  let escape = false;
  let brace = 0;
  let bracket = 0;
  for (const ch of t) {
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket -= 1;
  }
  if (inString) t += '"';
  // Close in reverse nest order (arrays inside objects is the common case).
  while (bracket > 0) {
    t += "]";
    bracket -= 1;
  }
  while (brace > 0) {
    t += "}";
    brace -= 1;
  }
  t = t.replace(/,\s*([}\]])/g, "$1");

  try {
    JSON.parse(t);
    return t;
  } catch {
    return null;
  }
}

/**
 * Finalize a research markdown reply:
 * - repair a trailing incomplete research fence when JSON is salvageable
 * - otherwise drop the incomplete fence so raw embed source never renders
 */
export function finalizeResearchReport(text: string): string {
  let working = String(text || "");
  if (!working) return working;

  const lastFence = working.lastIndexOf("```");
  if (lastFence < 0) return working;

  const after = working.slice(lastFence + 3);
  if (after.includes("```")) return working;

  const langMatch = after.match(RESEARCH_FENCE_LANG_RE);
  if (!langMatch) return working;

  const lang = langMatch[1].toLowerCase();
  const body = after.slice(langMatch[0].length).replace(/^\r?\n/, "");

  if (lang === "stock") {
    const symbol = body.trim().split(/\n/)[0]?.trim() || "";
    if (symbol && /^[A-Z0-9.$:=^-]{1,32}$/i.test(symbol)) {
      return (
        working.slice(0, lastFence) +
        "```stock\n" +
        symbol.toUpperCase().replace(/^\$/, "") +
        "\n```"
      );
    }
    return working.slice(0, lastFence).replace(/\s+$/u, "");
  }

  const repaired = tryRepairJsonText(body);
  if (repaired) {
    const fenceLang = lang === "spreadsheet" || lang === "csv" ? "sheet" : lang;
    return (
      working.slice(0, lastFence) +
      "```" +
      fenceLang +
      "\n" +
      repaired +
      "\n```"
    );
  }

  // Unsalvageable — drop the truncated embed rather than show raw code.
  return working.slice(0, lastFence).replace(/\s+$/u, "");
}
