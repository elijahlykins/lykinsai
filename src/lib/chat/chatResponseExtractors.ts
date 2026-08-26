// Pure response-analysis and extraction helpers the chat send pipeline uses
// to post-process assistant replies: source-link extraction, AI-connection
// tags, plain web links, and video-question heuristics. Extracted verbatim
// from src/hooks/useChatEngine.ts (chat engine decomposition Wave 1, see
// docs/REFACTOR_LOG.md), where each was wrapped in a dependency-free
// useCallback purely so it could ride into orchestrateChatSend's params.
// The impure siblings (extractAndApplyTagActions — Supabase writes;
// validateYouTubeVideoId / extractAndEmbedYouTubeUrls — fetch with the
// user's token + setChatMessages) intentionally stay in the hook.

export function looksLikeDeflectingQuestion(s: string) {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return true;
  return /(would you like|do you want|want me to|should i|it seems like|would you want|do you need)/i.test(t);
}

export function isVideoQuestion(s: string) {
  const t = String(s || "").toLowerCase();
  const hasVideoWord = /\b(video|youtube|clip|short|reel|transcript|watch|recording)\b/i.test(t);
  if (hasVideoWord) return true;
  if (/transcri(?:be|pt|ption)/i.test(t)) return true;
  const hasPronouns = /\b(he|she|they|speaker|narrator|host|presenter)\b/i.test(t);
  if (hasPronouns && /\b(say(?:s|ing)?|said|talk(?:s|ing)?|mention|discuss|explain|point)\b/i.test(t)) return true;
  return false;
}

export function buildDirectVideoAnswerFromGrounding(grounding: string) {
  const raw = String(grounding || "").trim();
  if (!raw || raw === "(none)") return "";
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => /^\-\s*\[\d{2}:\d{2}\-\d{2}:\d{2}\]\s+/.test(l)).slice(0, 8).map((l) => l.replace(/^\-\s*/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!lines.length) return "";
  const keyPoints = lines.slice(0, 5).map((l) => `- ${l}`);
  return [`From the on-board video transcript:`, `Answer: ${lines[0]}`, `Key grounded points:\n${keyPoints.join("\n")}`].join("\n\n");
}

export function extractSourceLinks(text: string): { cleanText: string; sources: { title: string; url: string }[] } {
  // Require at least one newline before the header so we don't grab the word
  // "sources:" or "references:" when the model uses it in the middle of a
  // sentence (case-insensitive match previously chopped off the rest of a
  // long response whenever prose like "The main sources:\n..." appeared).
  const sm = text.match(/\n+(?:Sources?|References?):?[ \t]*\n([\s\S]*?)$/i);
  if (!sm) return { cleanText: text, sources: [] };
  const block = sm[1].trim();
  const sources: { title: string; url: string }[] = [];
  const lr = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = lr.exec(block)) !== null) sources.push({ title: m[1], url: m[2] });
  if (!sources.length) { const br = /(?:^|\n)\s*\d+\.\s*(https?:\/\/[^\s]+)/g; while ((m = br.exec(block)) !== null) { try { const u = new URL(m[1]); sources.push({ title: u.hostname.replace(/^www\./, ""), url: m[1] }); } catch {} } }
  // Only strip the trailing block when we actually extracted real citation
  // links. Otherwise the match was likely a false positive (e.g. the AI used
  // "Sources:" as an inline list header) and we'd silently delete the rest
  // of the response.
  if (!sources.length) return { cleanText: text, sources: [] };
  const ct = text.slice(0, sm.index).trimEnd();
  return { cleanText: ct, sources };
}

export function extractAiConnections(responseText: string) {
  const re = /\[AI_CONNECTION:(.+?)\|(.+?)\|(.+?)\]/g;
  const conns: Array<{ title: string; sourceType: "board" | "media"; reason: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(responseText)) !== null) { const title = m[1].trim(); const rt = m[2].trim().toLowerCase(); const reason = m[3].trim(); if (title && reason) conns.push({ title, sourceType: rt === "board" ? "board" : "media", reason }); }
  return { connections: conns.slice(0, 3), cleanText: responseText.replace(/\s*\[AI_CONNECTION:[^\]]*\]/g, "").trimEnd() };
}

export function extractWebLinksFromText(text: string): string[] {
  const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
  const ytHosts = ["youtube.com", "youtu.be", "youtube-nocookie.com"];
  const seen = new Set<string>(); const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) { const raw = m[0].replace(/[.,;:!?)]+$/, ""); try { const host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase(); if (ytHosts.some((h) => host.includes(h))) continue; if (!seen.has(raw)) { seen.add(raw); links.push(raw); } } catch {} }
  return links.slice(0, 5);
}
