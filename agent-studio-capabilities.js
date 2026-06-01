// ============================================================================
// agent-studio-capabilities.js — what hosted agents CAN and CANNOT do (for LLM prompts)
// ============================================================================

/**
 * Fed to Opus at compose + codegen so specs and handler.mjs match LYKN reality.
 */
export const AGENT_STUDIO_RUNTIME_MANIFEST = `
## LYKN Agent Studio — runtime truth (read before designing or coding)

### What runs your agent
- User describes an agent → you output agent/handler.mjs → **Run agent** executes \`runAgent({ message, tools, context })\` in an in-process sandbox.
- \`tools(name, args)\` is the ONLY way to touch LYKN data. No fetch(), no fs, no child_process, no external APIs unless OAuth integrations were declared at build time.
- \`context.synthesis\` is a text excerpt (beliefs, project, rules) — not a live DB. Refresh data with tools on every run.
- On run, you MUST call tools and return a markdown \`reply\` with real results. Never return only "ready" or "say go".

### Sandbox limits (cannot do)
- Cannot browse the public web, run arbitrary code, install packages, or call OpenAI/Anthropic directly.
- Cannot read Gmail/Slack/Notion/Drive unless \`integrations_required\` included that connector AND the user connected it in LYKN (otherwise explain the gap).
- Cannot do semantic/embedding vault search — only substring search (see below).
- Cannot list "all vault rows" via lykn_searchVault alone — search requires a query string that appears in title or body.

### lykn_searchVault — CAN
- Substring match on vault note title + content (Postgres ilike). Returns up to 25 hits, **newest first**.
- Args: { query: string (required, short), limit?: 1-25 }.
- Returns: { hits: [{ node_id: "vault_<uuid>", id, title, snippet, tags, url, updated_at }] }.
- Use **several targeted queries** (e.g. "UI design", "robotics", "meeting notes") — NOT the user's full sentence split into random words.

### lykn_searchVault — CANNOT / pitfalls
- Will NOT return notes that don't contain the query substring → "list everything in my vault" fails if you only search "everything" or "agent".
- For **full vault inventory** (list all / go through entire vault / catalog everything): you MUST use the inventory pattern in handler code (see codegen template) — multiple broad queries like "note", "http", "the", "a" are unreliable; prefer paging through search with empty-broad strategy OR call lykn_getRecentActivity with kinds: ["vault"], days: 90, limit: 60 AND merge with several generic queries, OR implement listVaultInventoryPattern below.

### Full vault inventory pattern (handler code — use when user wants ALL items)
\`\`\`javascript
// Broad merge: recent-activity vault rows + search with very common substrings
async function listAllVaultHits(tools, wrap) {
  const byId = new Map();
  const addHits = (hits) => {
    for (const h of hits || []) {
      const id = h?.node_id || (h?.id ? \`vault_\${h.id}\` : null);
      if (id) byId.set(String(id), h);
    }
  };
  // Recent vault items (time-ordered, not keyword-complete)
  try {
    const recent = await wrap("lykn_getRecentActivity", { days: 90, kinds: ["vault"], limit: 60 });
    for (const item of recent?.items || recent?.activity || []) {
      if (item?.node_id) byId.set(item.node_id, { node_id: item.node_id, title: item.label || item.title || "Untitled", snippet: "", tags: [] });
    }
  } catch (_) {}
  // Common substrings that appear in many notes (cast a wide net)
  for (const q of ["http", "note", "the", "lykn", "vault", ""]) {
    if (!q) continue;
    const res = await wrap("lykn_searchVault", { query: q, limit: 25 });
    addHits(res?.hits);
  }
  return [...byId.values()];
}
\`\`\`
For true completeness, document in reply: "Listed N unique items (merged from recent activity + broad search). Vault may have more than N if items don't match common substrings."

### lykn_getRecentActivity — CAN
- Recent changes across synthesis: beliefs, facts, vault, projects, links. Args: { days?: 1-90, kinds?: [...], limit?: 1-60 }.
- Good for "what's new" — **bad as sole source for full vault list** (cap per kind, not exhaustive).

### lykn_getRules — response shape (common codegen bug)
- Returns \`{ ok, count, rules: [{ id, belief_id, trigger_text, action_text, ... }] }\`
- \`rules\` is an **array**, NOT a string. NEVER \`rules.toLowerCase()\`. Use \`rulesRes.rules\` or destructure \`const { rules: rulesList } = await tools('lykn_getRules', {})\`.

### lykn_getBeliefs — response shape
- Returns \`{ ok, count, beliefs: [{ id, text, ... }] }\` — iterate \`beliefs\`, not string methods on the payload.

### lykn_loadNeuron / lykn_loadNeurons — CAN
- Load full body after search. Always use hit.node_id (with vault_ prefix), never bare uuid.
- For **vault inventory / list-all** tasks: use searchVault + getRecentActivity for titles — do NOT loadNeurons on dozens of items (max 10 per call, spams tool budget).

### Email/Gmail vault items
- Many vault rows are Gmail syncs (tags: gmail, email, inbox). For design/UI tasks, filter these out. For "list everything", include them.

### lykn_pushProjectState / lykn_recordRuleApplication
- Call when making durable project updates or applying a rule (pass rule_id from context).

### Tool selection guidance for compose
- Vault browse/list → lykn_searchVault + lykn_getRecentActivity + lykn_loadNeurons
- Beliefs/rules → lykn_getBeliefs, lykn_getRules, lykn_recordRuleApplication
- Projects → lykn_listProjects, lykn_getProjectState, lykn_pushProjectState
- Do NOT add tools the agent won't call. Do NOT promise capabilities outside this manifest.
`.trim();

export const AGENT_STUDIO_COMPOSE_MANIFEST = `
## LYKN capabilities (design agents that match reality)

${AGENT_STUDIO_RUNTIME_MANIFEST}

### Compose-specific
- \`instructions\` must encode the CAN/CANNOT rules above for this agent's job (e.g. inventory vs keyword search).
- Pick 2-8 tools from the allowlist that are sufficient — no invented tool names.
- If the job is "list everything in vault", instructions MUST describe inventory behavior (not one keyword search).
- If the job is topic search (UI, robotics), instructions MUST list example search queries and email exclusion if relevant.
`.trim();

export function buildCodegenSystemPrompt({ toolList, integrationList }) {
  return `You are a senior engineer implementing a LYKN hosted agent in Agent Studio.

${AGENT_STUDIO_RUNTIME_MANIFEST}

Write a single ES module file \`agent/handler.mjs\` that exports:

export async function runAgent({ message, tools, context }) {
  // message: string user input
  // tools: async (name, args) => result — only call tools from the allowlist
  // context: { beliefs, project, synthesis } strings
  return { reply: string, toolCalls?: array };
}

Requirements:
- Implement the agent behavior from the brief using ONLY these LYKN tools: ${toolList}
- Honor integrations: ${integrationList} (OAuth-gated — if not connected, explain in reply)
- Read the manifest above: if the task is list-all-vault, implement listAllVaultHits or equivalent; if topic search, use multiple specific queries
- Include helper functions in the file as needed (wrap tools, filter email, merge hits)
- Call lykn_pushProjectState when making durable project updates; lykn_recordRuleApplication when applying a rule (rule_id)
- Robust try/catch; never throw — return { reply: error message }
- On runAgent, execute immediately with tools — never "ready to start" without tool calls
- No external npm imports; Node 18+ ESM; keep under ~200 lines
- searchVault returns { hits: [...] } — use hit.node_id for lykn_loadNeurons({ node_ids: [...] })
- Return markdown reply listing real titles/snippets from tool results
- NEVER assign \`const rules = await tools('lykn_getRules')\` then call string methods on \`rules\` — use \`rulesList = rulesPayload?.rules || []\`
- Variable names: use \`rulesPayload\`, \`rulesList\`, \`beliefsPayload\` — avoid bare \`rules\` unless it is a string
- Output ONLY raw JavaScript for agent/handler.mjs — no markdown fences, no JSON wrapper`;
}
