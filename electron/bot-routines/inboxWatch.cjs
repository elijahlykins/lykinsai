"use strict";

/**
 * Inbox-watch routines: Gmail (and similar mail MCP connections) as a
 * standing poll. Creation requires a live connection. Execution reads
 * through MCP — it never pretends the browser or Vault is an inbox.
 */

const INBOX_WATCH_RE =
  /\b(watch|monitor|keep an eye on|ping me|alert me|notify me|tell me|let me know)\b.{0,80}\b(gmail|inbox|e-?mail|new mail|new message)\b|\b(gmail|inbox|e-?mail)\b.{0,80}\b(watch|monitor|ping|alert|notify|new)\b|\bgmail\b.{0,40}\b(alert|watch|inbox)\b|\bnew email alerts?\b/i;

const INBOX_CAP_RE = /^communication\.email\.(search|read|list)$/i;

function looksLikeInboxWatch(text) {
  return INBOX_WATCH_RE.test(String(text || ""));
}

function connectionIdentity(conn) {
  if (!conn || typeof conn !== "object") return "";
  const label = String(conn.accountLabel || "").trim();
  const identity = String(conn.accountIdentity || "").trim();
  const name = String(conn.name || "").trim();
  if (label && identity && label !== identity) return `${label} (${identity})`;
  return identity || label || name || "connected inbox";
}

function isInboxConnection(conn) {
  if (!conn || typeof conn !== "object") return false;
  const blob = `${conn.catalogId || ""} ${conn.name || ""} ${conn.accountLabel || ""} ${conn.accountIdentity || ""}`.toLowerCase();
  if (/\bgmail\b|google mail|lykn:gmail|lykn:google-workspace/.test(blob)) return true;
  const tools = conn.capabilitySummary?.tools || conn.capabilities || [];
  return (Array.isArray(tools) ? tools : []).some((item) =>
    /^communication\.email\./i.test(String(item)),
  );
}

function matchInboxConnections(connections) {
  return (Array.isArray(connections) ? connections : []).filter(
    (conn) =>
      isInboxConnection(conn) &&
      String(conn.status || "") !== "revoked" &&
      String(conn.status || "") !== "error",
  );
}

function watchedAccountFromInstructions(text) {
  const match = /^Watching:\s*(.+)$/m.exec(String(text || ""));
  return match ? match[1].trim() : "";
}

function bindInboxInstructions(instructions, conn) {
  const identity = connectionIdentity(conn);
  const body = String(instructions || "")
    .replace(/^Watching:\s*.+\n\n/m, "")
    .trim();
  return `Watching: ${identity}\n\n${body || "Ping when new mail arrives in this connected inbox. Read only. Do not send, delete, or modify mail."}`;
}

function pickInboxSearchTool(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const scored = list
    .map((tool) => {
      const caps = tool.capabilities || tool.semanticCapabilities || [];
      const name = String(tool.name || tool.toolName || "");
      let score = 0;
      if (caps.some((cap) => INBOX_CAP_RE.test(String(cap)))) score += 10;
      if (/search|list|query/i.test(name)) score += 4;
      if (/email|mail|inbox|message/i.test(name)) score += 3;
      if (/send|delete|trash|create|draft/i.test(name)) score -= 8;
      return { tool, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.tool || null;
}

function walkMessages(value, out, depth = 0) {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkMessages(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const id = String(value.id || value.messageId || value.message_id || value.threadId || "").trim();
  const subject = String(value.subject || value.title || "").trim();
  const from = String(value.from || value.sender || value.fromEmail || value.from_email || "").trim();
  if (id || subject || from) {
    out.push({
      id: id || `${from}|${subject}`.slice(0, 160),
      subject: subject.slice(0, 160),
      from: from.slice(0, 160),
    });
  }
  for (const key of ["messages", "emails", "results", "items", "data", "threads"]) {
    if (value[key]) walkMessages(value[key], out, depth + 1);
  }
}

function extractMessages(observation) {
  const raw = observation?.observation ?? observation?.output ?? observation;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { text: raw };
    }
  }
  const out = [];
  walkMessages(parsed, out);
  const seen = new Set();
  return out.filter((item) => {
    const key = item.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatNewMail(messages, identity) {
  const rows = (messages || []).slice(0, 5).map((item) => {
    const who = item.from || "unknown sender";
    const subject = item.subject || "(no subject)";
    return `${who}: ${subject}`;
  });
  const more = messages.length > 5 ? ` (+${messages.length - 5} more)` : "";
  const where = identity ? ` in ${identity}` : "";
  if (!rows.length) return `New mail arrived${where}.`;
  return `New mail${where}:\n${rows.join("\n")}${more}`;
}

function diffNewMessages(current, seenIds) {
  const known = new Set(Array.isArray(seenIds) ? seenIds.map(String) : []);
  return (current || []).filter((item) => item.id && !known.has(item.id));
}

function nextSeenIds(current, prev) {
  const merged = [...(current || []).map((item) => item.id), ...(Array.isArray(prev) ? prev : [])];
  return [...new Set(merged.filter(Boolean))].slice(0, 80);
}

module.exports = {
  looksLikeInboxWatch,
  connectionIdentity,
  isInboxConnection,
  matchInboxConnections,
  watchedAccountFromInstructions,
  bindInboxInstructions,
  pickInboxSearchTool,
  extractMessages,
  formatNewMail,
  diffNewMessages,
  nextSeenIds,
};
