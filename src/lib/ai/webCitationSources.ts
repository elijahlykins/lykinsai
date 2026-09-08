// Citation links shown on the sources pill / rail. Mirrors
// lib/exterior/webSearch.js extractors so the renderer can harvest
// tool_call results even if an SSE `sources` event is late or missing.

const WEB_SOURCE_TOOLS = new Set([
  "lykn_web_search",
  "web_search",
  "lykn_web_fetch",
  "web_fetch",
]);

export type CitationSource = { title: string; url: string };

export function mergeCitationSources(
  base: CitationSource[] | null | undefined,
  extra: CitationSource[] | null | undefined,
): CitationSource[] {
  const out: CitationSource[] = [];
  const seen = new Set<string>();
  for (const raw of [...(base || []), ...(extra || [])]) {
    if (!raw || typeof raw !== "object") continue;
    const url = String(raw.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(raw.title || url).trim().slice(0, 160) || url,
      url,
    });
    if (out.length >= 40) break;
  }
  return out;
}

export function extractSourcesFromWebToolResult(
  name: string | undefined,
  result: any,
): CitationSource[] {
  if (!WEB_SOURCE_TOOLS.has(String(name || "")) || !result || result.ok === false) {
    return [];
  }
  const extra: CitationSource[] = [];
  if (Array.isArray(result.results)) {
    for (const hit of result.results) {
      if (hit && hit.url) extra.push({ title: String(hit.title || ""), url: String(hit.url) });
    }
  }
  if (Array.isArray(result.pages)) {
    for (const page of result.pages) {
      if (page && page.url) extra.push({ title: String(page.title || ""), url: String(page.url) });
    }
  }
  if (typeof result.url === "string" && result.url.trim()) {
    extra.push({ title: String(result.title || ""), url: result.url });
  }
  return mergeCitationSources([], extra);
}

export function uniqueHostSources(sources: CitationSource[], limit = 3): CitationSource[] {
  const seen = new Set<string>();
  const out: CitationSource[] = [];
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

export function citationSourcesFromMessage(msg: {
  sources?: CitationSource[];
  toolCalls?: Array<{ name?: string; status?: string; result?: any }>;
} | null | undefined): CitationSource[] {
  if (!msg) return [];
  const listed = Array.isArray(msg.sources) ? msg.sources : [];
  const fromTools: CitationSource[] = [];
  for (const call of Array.isArray(msg.toolCalls) ? msg.toolCalls : []) {
    if (call?.status && call.status !== "done") continue;
    fromTools.push(...extractSourcesFromWebToolResult(call?.name, call?.result));
  }
  return mergeCitationSources(listed, fromTools);
}
