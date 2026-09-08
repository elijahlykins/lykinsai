/**
 * Parse a `/path` token in the Glass composer. Keep in lockstep with
 * src/lib/chat/slashPathQuery.ts — that file is the tested copy.
 */

export function findSlashPathToken(text, cursor) {
  const pos = Math.max(0, Math.min(Number(cursor) || 0, String(text || "").length));
  const before = String(text || "").slice(0, pos);
  const match = /(?:^|[\s])(\/[^\s]*)$/.exec(before);
  if (!match) return null;
  const raw = match[1];
  if (raw.startsWith("//")) return null;
  const start = before.length - raw.length;
  return { start, end: pos, raw };
}

export function splitSlashPathQuery(raw) {
  const token = String(raw || "");
  if (!token || token === "/") {
    return { dir: "~", filter: "", useRoots: true };
  }
  const trailingSlash = token.length > 1 && token.endsWith("/");
  const rest = token.slice(1);
  if (!trailingSlash && !rest.includes("/")) {
    return { dir: "~", filter: rest, useRoots: true };
  }
  if (trailingSlash) {
    const dir = token.replace(/\/+$/, "") || "/";
    return { dir, filter: "", useRoots: false };
  }
  const lastSlash = token.lastIndexOf("/");
  return {
    dir: lastSlash <= 0 ? "/" : token.slice(0, lastSlash),
    filter: token.slice(lastSlash + 1),
    useRoots: false,
  };
}

export function slashNameMatchRank(name, q) {
  if (!name.includes(q)) return -1;
  if (name === q) return 0;
  if (name.startsWith(q)) {
    const next = name.charAt(q.length);
    if (!next || /[-_./ ]/.test(next)) return 1;
    return 2;
  }
  const at = name.indexOf(q);
  const before = at > 0 ? name.charAt(at - 1) : "";
  if (!before || /[-_./ ]/.test(before)) return 3;
  return 4;
}

function pathDepth(path) {
  return String(path || "").split("/").filter(Boolean).length;
}

export function rankSlashPathItems(items, filter) {
  const q = String(filter || "").toLowerCase();
  if (!q) return items.slice();
  return items
    .map((item, index) => {
      const name = String(item?.name || "").toLowerCase();
      return {
        item,
        index,
        rank: slashNameMatchRank(name, q),
        name,
        kind: item?.kind,
        path: String(item?.path || ""),
      };
    })
    .filter((row) => row.rank >= 0)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      const depth = pathDepth(a.path) - pathDepth(b.path);
      if (depth) return depth;
      const alpha = a.name.localeCompare(b.name);
      if (alpha) return alpha;
      return a.index - b.index;
    })
    .map((row) => row.item);
}

export function replaceSlashPathToken(text, token, insert) {
  return String(text || "").slice(0, token.start) + String(insert || "") + String(text || "").slice(token.end);
}

export function slashPathDisplay(path, home) {
  const abs = String(path || "");
  const homeDir = String(home || "").replace(/\/+$/, "");
  if (homeDir && (abs === homeDir || abs.startsWith(`${homeDir}/`))) {
    return `~${abs.slice(homeDir.length)}`;
  }
  return abs;
}
