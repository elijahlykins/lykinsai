// Agent rail data helpers — pure functions that shape the runtime's agent /
// history feeds for the rail: row labels, Today/Yesterday/Older grouping,
// thread merging, and the post-finish suggestion / source-link chips.
import { MessageCircle, Sparkles, Telescope } from "lucide-react";

export function historySubLabel(h) {
  let host = "";
  try {
    host = h.url ? new URL(h.url).hostname.replace(/^www\./, "") : "";
  } catch {
    /* unparsable url */
  }
  let when = "";
  try {
    if (h.closedAt) {
      when = new Date(h.closedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
    }
  } catch {
    /* bad timestamp */
  }
  if (host && when) return `${host} · ${when}`;
  return host || when || "agent";
}

export function agentSubLabel(a) {
  const skill = String(a.skill || "").trim();
  const step = String(a.step || a.status || "idle").trim();
  if (skill && step && step !== skill) return `${skill} · ${step}`;
  return skill || step || "idle";
}

export function agentHostLabel(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dateSectionLabel(iso) {
  const t = new Date(iso || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return "Older";
  const today = startOfLocalDay();
  if (t >= today) return "Today";
  if (t >= today - 86400000) return "Yesterday";
  return "Older";
}

export function groupByDateSection(items, getIso) {
  const buckets = { Today: /** @type {any[]} */ ([]), Yesterday: /** @type {any[]} */ ([]), Older: /** @type {any[]} */ ([]) };
  for (const item of items) {
    buckets[dateSectionLabel(getIso(item))].push(item);
  }
  return ["Today", "Yesterday", "Older"]
    .map((label) => ({ label, items: buckets[label] }))
    .filter((g) => g.items.length > 0);
}

function threadLooksSame(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.role !== b[i]?.role) return false;
    if (String(a[i]?.content || "") !== String(b[i]?.content || "")) return false;
  }
  return true;
}

/** Runtime history wins; keep a trailing optimistic user line the registry hasn't echoed yet. */
export function mergeAgentThread(prev, next) {
  const incoming = Array.isArray(next) ? next : [];
  const current = Array.isArray(prev) ? prev : [];
  if (threadLooksSame(current, incoming)) return current;
  const lastPrev = current[current.length - 1];
  if (
    lastPrev?.role === "user" &&
    String(lastPrev.content || "").trim() &&
    !incoming.some(
      (m) =>
        m?.role === "user" &&
        String(m.content || "") === String(lastPrev.content || ""),
    )
  ) {
    return [...incoming, lastPrev];
  }
  return incoming;
}

/** Short topic phrase for post-agent suggestion labels. */
function agentSuggestionTopic(raw, maxLen = 42) {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  t = t
    .replace(
      /^(please\s+)?(?:can you\s+)?(?:go\s+)?(?:and\s+)?(?:please\s+)?(?:open|browse|visit|research|find|look up|search|check|monitor|build|create|make|write|do)\s+(?:me\s+)?(?:an?\s+)?/i,
      "",
    )
    .replace(/[.?!]+$/, "")
    .trim();
  if (!t) return "this";
  if (t.length > maxLen) {
    t = `${t.slice(0, Math.max(12, maxLen - 1)).replace(/\s+\S*$/, "")}…`;
  }
  return t;
}

/** One-tap next steps after an agent turn finishes — same role as Build / Research. */
export function agentFollowUpItems(topic) {
  const blank = agentSuggestionTopic(topic, 36);
  const fullTopic = agentSuggestionTopic(topic, 160);
  return [
    {
      key: "continue",
      label: "Keep going",
      prompt:
        "Keep going from here — take the next useful steps and finish anything still open",
      icon: Sparkles,
    },
    {
      key: "deeper",
      label: `Dig deeper into ${blank}`,
      prompt: `Dig deeper into ${fullTopic}: open related pages, pull more detail, and report what matters`,
      icon: Telescope,
    },
    {
      key: "next",
      label: "What's the best next step?",
      prompt: "Based on what you just did, what's the best next step — and do it",
      icon: MessageCircle,
    },
  ];
}

const AGENT_SUGGEST_ICONS = [Sparkles, Telescope, MessageCircle];

/** Map runtime / LLM follow-up strings into rail chip objects. */
export function mapAgentSuggestionChips(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((raw, i) => {
      if (raw == null) return null;
      if (typeof raw === "string") {
        const prompt = raw.replace(/\s+/g, " ").trim();
        if (!prompt) return null;
        return {
          key: `custom-${i}`,
          label: prompt.length > 56 ? `${prompt.slice(0, 55).replace(/\s+\S*$/, "")}…` : prompt,
          prompt,
          icon: AGENT_SUGGEST_ICONS[i % AGENT_SUGGEST_ICONS.length],
        };
      }
      const prompt = String(raw.prompt || raw.label || "").replace(/\s+/g, " ").trim();
      if (!prompt) return null;
      const label = String(raw.label || prompt).replace(/\s+/g, " ").trim();
      return {
        key: String(raw.key || `custom-${i}`),
        label: label.length > 56 ? `${label.slice(0, 55).replace(/\s+\S*$/, "")}…` : label,
        prompt,
        icon: AGENT_SUGGEST_ICONS[i % AGENT_SUGGEST_ICONS.length],
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

/** Source links from /api/ai/suggest — open in the Studio browser. */
export function mapAgentSourceLinks(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw) continue;
    const url = String(raw.url || raw.href || "").trim();
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
    const title = String(raw.title || host || url).replace(/\s+/g, " ").trim();
    out.push({
      key: `src-${out.length}`,
      title: title.length > 56 ? `${title.slice(0, 55).replace(/\s+\S*$/, "")}…` : title,
      host,
      url,
    });
    if (out.length >= 4) break;
  }
  return out;
}

/** Pull http(s) URLs out of a finished agent answer (## Link, markdown, bare). */
export function extractSourceLinksFromAnswer(text) {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  const found = [];
  const seen = new Set();
  const push = (url, title) => {
    const u = String(url || "").trim().replace(/[),.;]+$/, "");
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) return;
    if (/lykn-agent-step:\/\//i.test(u)) return;
    seen.add(u);
    let host = "";
    try {
      host = new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return;
    }
    const label = String(title || host || u).replace(/\s+/g, " ").trim();
    found.push({
      key: `ans-${found.length}`,
      title: label.length > 56 ? `${label.slice(0, 55).replace(/\s+\S*$/, "")}…` : label,
      host,
      url: u,
    });
  };
  const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
  let m;
  while ((m = md.exec(raw)) !== null) push(m[2], m[1]);
  const bare = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
  while ((m = bare.exec(raw)) !== null) push(m[0], "");
  return found.slice(0, 4);
}
