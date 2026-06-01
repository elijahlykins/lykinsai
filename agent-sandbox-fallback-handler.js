// ============================================================================
// Capabilities-aware fallback handler source when Opus codegen fails validation
// ============================================================================

/**
 * @param {object} spec
 * @returns {string} handler.mjs source
 */
export function buildCapabilitiesAwareFallbackHandler(spec) {
  const name = String(spec?.name || 'Agent').replace(/"/g, '\\"');
  const tools = (spec?.tools || ['lykn_searchVault']).map((t) => JSON.stringify(t)).join(', ');
  const wantsInventory =
    /list|inventory|everything|all items|go(?:es)?\s+through|full vault|catalog/i.test(
      `${spec?.instructions || ''} ${spec?.source_description || ''} ${spec?.description || ''}`,
    );

  if (wantsInventory) {
    return `export async function runAgent({ message, tools, context }) {
  const toolCalls = [];
  const wrap = async (toolName, args) => {
    try {
      const result = await tools(toolName, args);
      toolCalls.push({ tool: toolName, args, ok: true });
      return result;
    } catch (err) {
      toolCalls.push({ tool: toolName, args, ok: false, error: String(err?.message || err) });
      return null;
    }
  };

  const byId = new Map();
  const addHits = (hits) => {
    for (const h of hits || []) {
      const id = h?.node_id || (h?.id ? \`vault_\${h.id}\` : null);
      if (id) byId.set(String(id), h);
    }
  };

  try {
    const recent = await wrap("lykn_getRecentActivity", { days: 90, kinds: ["vault"], limit: 60 });
    const items = recent?.items || recent?.activity || [];
    for (const item of items) {
      if (item?.node_id) {
        byId.set(item.node_id, {
          node_id: item.node_id,
          title: item.label || item.title || "Untitled",
          snippet: "",
          tags: [],
        });
      }
    }
  } catch (_) {}

  for (const q of ["http", "note", "the", "a", "lykn"]) {
    const res = await wrap("lykn_searchVault", { query: q, limit: 25 });
    addHits(res?.hits);
  }

  const hits = [...byId.values()];
  const lines = ["# ${name}", "", "Task: " + String(message || "").trim(), "", "## Vault inventory (" + hits.length + " unique items)", ""];
  if (!hits.length) {
    lines.push("_No vault items found. Save notes in LYKN Vault first._");
  } else {
    let i = 0;
    for (const h of hits) {
      i += 1;
      const tags = Array.isArray(h.tags) && h.tags.length ? " (" + h.tags.join(", ") + ")" : "";
      lines.push("### " + i + ". " + (h.title || "Untitled") + tags);
      if (h.snippet) lines.push(String(h.snippet).slice(0, 400));
      if (h.url) lines.push("Link: " + h.url);
      lines.push("");
    }
    lines.push("_Merged from recent vault activity + broad search. Some older items may be missing if they lack common substrings._");
  }
  if (context?.synthesis) lines.push("", "## Context", context.synthesis.slice(0, 800));
  return { reply: lines.join("\\n"), toolCalls };
}`;
  }

  return `export async function runAgent({ message, tools, context }) {
  const toolCalls = [];
  const wrap = async (toolName, args) => {
    try {
      const result = await tools(toolName, args);
      toolCalls.push({ tool: toolName, args, ok: true });
      return result;
    } catch (err) {
      toolCalls.push({ tool: toolName, args, ok: false, error: String(err?.message || err) });
      return null;
    }
  };

  const allowed = new Set([${tools}]);
  const queries = [];
  const msg = String(message || "").toLowerCase();
  if (/ui|design|figma|wireframe/.test(msg)) {
    queries.push("UI design", "design system", "figma", "wireframe", "mockup");
  }
  const words = String(message || "").split(/\\s+/).filter((w) => w.length > 4).slice(0, 4);
  queries.push(...words);
  if (!queries.length) queries.push("note");

  const byId = new Map();
  for (const q of [...new Set(queries)].slice(0, 10)) {
    if (!allowed.has("lykn_searchVault")) continue;
    const res = await wrap("lykn_searchVault", { query: q, limit: 20 });
    for (const h of res?.hits || []) {
      const id = h?.node_id || h?.id;
      if (id) byId.set(String(id), h);
    }
  }

  const lines = ["# ${name}", "", "## Results (" + byId.size + ")", ""];
  if (!byId.size) lines.push("_No matches. Try a more specific topic or list-all-vault wording._");
  else {
    let i = 0;
    for (const h of byId.values()) {
      i += 1;
      lines.push("### " + i + ". " + (h.title || "Untitled"));
      if (h.snippet) lines.push(String(h.snippet).slice(0, 400));
      lines.push("");
    }
  }
  return { reply: lines.join("\\n"), toolCalls };
}`;
}
