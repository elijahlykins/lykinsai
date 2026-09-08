/**
 * Parse a `/path` token in a chat composer so typing `/` can autocomplete
 * a file or folder on this machine. Trigger is a slash at the start of the
 * field or after whitespace - not a slash inside a word or inside `https://`.
 */

export type SlashPathToken = {
  start: number;
  end: number;
  raw: string;
};

export type SlashPathSplit = {
  /** Directory to list. `~` means the user's home. */
  dir: string;
  /** Name prefix to filter inside `dir`. */
  filter: string;
  /** When true, also offer Local Mode roots (Desktop, Documents, synced folders). */
  useRoots: boolean;
};

export type SlashPathItem = {
  name: string;
  path: string;
  kind: "file" | "folder" | "model" | "app";
  subtitle?: string;
  tag?: string;
  locked?: boolean;
  logoUrl?: string;
};

/**
 * The `/…` token under the caret, or null if this slash is not a path command.
 */
export function findSlashPathToken(text: string, cursor: number): SlashPathToken | null {
  const pos = Math.max(0, Math.min(Number(cursor) || 0, String(text || "").length));
  const before = String(text || "").slice(0, pos);
  const match = /(?:^|[\s])(\/[^\s]*)$/.exec(before);
  if (!match) return null;
  const raw = match[1];
  if (raw.startsWith("//")) return null;
  const start = before.length - raw.length;
  return { start, end: pos, raw };
}

/**
 * Turn `/Documents/re` into "list Documents, filter names starting with re".
 * A lone `/` or `/Name` (no extra slash) searches home + sidebar roots, then
 * name-searches nested files and folders inside Local Mode's allowlist.
 */
export function splitSlashPathQuery(raw: string): SlashPathSplit {
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

/** Closest-name rank: 0 exact, then prefix, then contains. -1 is no match. */
export function slashNameMatchRank(name: string, q: string): number {
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

function pathDepth(path: string): number {
  return String(path || "").split("/").filter(Boolean).length;
}

/**
 * Closest name first: exact `LYKN`, then `LYKN-example`, then other
 * prefix/contains hits. Folders beat files in the same match tier.
 */
export function rankSlashPathItems(items: SlashPathItem[], filter: string): SlashPathItem[] {
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

export function replaceSlashPathToken(text: string, token: SlashPathToken, insert: string): string {
  return String(text || "").slice(0, token.start) + String(insert || "") + String(text || "").slice(token.end);
}

export function slashPathDisplay(path: string, home = ""): string {
  const abs = String(path || "");
  const homeDir = String(home || "").replace(/\/+$/, "");
  if (homeDir && (abs === homeDir || abs.startsWith(`${homeDir}/`))) {
    return `~${abs.slice(homeDir.length)}`;
  }
  return abs;
}
