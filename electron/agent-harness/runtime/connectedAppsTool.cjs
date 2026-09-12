"use strict";

/**
 * connected_apps bot tool - act in the user's OAuth-connected apps through
 * the server's Universal MCP API (managed connections included).
 *
 * Electron never holds app tokens: every call goes through the
 * authenticated /api/mcp routes via the desktop MCP client, so the server's
 * full gate stack applies (connection status, capability check, consequence
 * approval, untrusted-result wrapping).
 *
 * Instruction modes, taught by agent/tools/connected_apps.md:
 *   "list"                                   -> ranked discovery tools
 *   "list unread inbox" / any non-JSON text  -> catalog search
 *   {"app": "...", "tool": "...", "args": {}} -> one tool call
 *
 * Consequential calls come back as waiting_for_approval; this module asks
 * the user through the injected requestApproval and retries once with the
 * minted approval token.
 */

const OUTPUT_CHAR_LIMIT = 6000;
const MAX_APPS_LISTED = 8;
const MAX_TOOLS_PER_APP = 8;

function parseInstruction(instruction) {
  const text = String(instruction || "").trim();
  if (!text || /^list$/i.test(text)) return { mode: "list" };
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      if (parsed && typeof parsed === "object" && parsed.tool) {
        return {
          mode: "call",
          app: String(parsed.app || "").trim(),
          tool: String(parsed.tool).trim(),
          args: parsed.args && typeof parsed.args === "object" ? parsed.args : {},
        };
      }
    } catch {
      /* fall through to search */
    }
  }
  const query = /^list\s+/i.test(text) ? text.replace(/^list\s+/i, "").trim() : text;
  return { mode: "search", query: query || "" };
}

function boundOutput(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = String(text || "");
  return text.length > OUTPUT_CHAR_LIMIT ? `${text.slice(0, OUTPUT_CHAR_LIMIT)}…` : text;
}

function matchConnection(connections, appRef) {
  const ref = String(appRef || "").trim().toLowerCase();
  if (!ref) return null;
  return (
    connections.find((c) => String(c.id || "").toLowerCase() === ref) ||
    connections.find((c) => String(c.id || "").toLowerCase().startsWith(ref)) ||
    connections.find((c) => String(c.name || "").toLowerCase() === ref) ||
    connections.find((c) => String(c.name || "").toLowerCase().includes(ref)) ||
    null
  );
}

function toolNameOf(tool) {
  return String(tool?.name || tool?.toolName || tool?.serverToolName || "").trim();
}

function stemToken(word) {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function tokensOf(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
    .map(stemToken);
}

/**
 * What the user (and the model speaking for them) calls a thing, mapped to
 * what tool catalogs actually call it.
 *
 * The scorer required a literal token overlap between the query and a tool's
 * name or description, so a search for "unread inbox" against Gmail returned
 * NOTHING: no Composio Gmail tool contains the word "inbox" — they are
 * GMAIL_FETCH_EMAILS, GMAIL_LIST_THREADS, GMAIL_GET_MESSAGE. The bot then
 * reported that it could not find a way into the mailbox, on an account that
 * was connected and working. Chat never hit this because chat injects the
 * connected tools into the model's tool list directly; only the Bot has to
 * find them by describing them.
 */
const QUERY_SYNONYMS = Object.freeze({
  inbox: ["mail", "email", "message"],
  unread: ["mail", "email", "message"],
  mailbox: ["mail", "email", "message"],
  mail: ["email", "message"],
  email: ["mail", "message"],
  message: ["mail", "email", "chat"],
  dm: ["message", "chat", "conversation"],
  chat: ["message", "conversation"],
  channel: ["conversation", "chat"],
  calendar: ["event", "schedule", "meeting"],
  meeting: ["event", "calendar"],
  doc: ["document", "page", "file"],
  page: ["document", "doc"],
  note: ["page", "document"],
  file: ["document", "drive"],
  ticket: ["issue", "task"],
  task: ["issue", "todo"],
  repo: ["repository"],
});

// Deliberately NOT expanded: "snapshot", "summary", "latest", "recent" and
// friends describe HOW to get something, not WHAT. Mapping them onto
// list/fetch/get made the query hit whichever tool happened to have "LIST" in
// its name — "latest videos" picked LIST_COMMENT_THREADS over SEARCH. The
// structural score already floats ready list/search/fetch tools to the top;
// query hits should only ever be about the subject.

/** Query tokens plus everything they are commonly called instead. */
function expandQueryTokens(tokens) {
  const out = new Set();
  for (const tok of tokens) {
    out.add(tok);
    for (const alt of QUERY_SYNONYMS[tok] || []) out.add(stemToken(alt));
  }
  return [...out];
}

/**
 * Semantic capabilities are the most reliable thing to match against — the
 * classifier already decided this tool is `communication.email.read`, which
 * says what it DOES rather than what someone named it.
 */
function capabilityTokens(tool) {
  const caps = Array.isArray(tool?.capabilities) ? tool.capabilities : [];
  return tokensOf(caps.join(" ").replace(/\./g, " "));
}

function requiredOf(tool) {
  return Array.isArray(tool?.required) ? tool.required.map(String) : [];
}

function isOpaqueArgKey(key) {
  const k = String(key || "");
  if (!k) return false;
  return /(_id|_sha|_ref)$/i.test(k) || /^(id|ref|sha)$/i.test(k);
}

function findListedTool(tools, name) {
  const want = String(name || "").trim();
  if (!want) return null;
  const list = Array.isArray(tools) ? tools : [];
  const lower = want.toLowerCase();
  return (
    list.find((t) => toolNameOf(t) === want) ||
    list.find((t) => toolNameOf(t).toLowerCase() === lower) ||
    list.find((t) => toolNameOf(t).toLowerCase().endsWith(`_${lower}`)) ||
    null
  );
}

function scoreListedTool(tool, query) {
  const name = toolNameOf(tool).replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  const desc = String(tool?.description || "").toLowerCase();
  const required = requiredOf(tool);
  const opaque = required.filter((key) => isOpaqueArgKey(key));
  const consequence = String(tool?.consequence || "read").toLowerCase();
  let score = 0;
  if (/\b(list|search|fetch)\b/.test(name) && opaque.length === 0) score += 40;
  if (required.length === 0) score += 15;
  if (/\b(get|read)\b/.test(name) && opaque.length === 0 && required.length <= 3) score += 12;
  if (/\b(authenticated|current.?user|for_the_user|profile|viewer)\b/.test(name)) score += 20;
  if (/\b(alpha|beta|deprecated|legacy)\b/.test(name)) score -= 20;
  if (opaque.length && opaque.length === required.length) score -= 8;
  if (/\b(send|delete|trash|create|draft)\b/.test(name) && !/\b(list|search|fetch)\b/.test(name)) {
    score -= 6;
  }
  const queryText = String(query || "");
  const qTokens = expandQueryTokens(tokensOf(queryText));
  if (qTokens.length) {
    const nameTokens = new Set(tokensOf(name));
    const descTokens = new Set(tokensOf(desc));
    const capTokens = new Set(capabilityTokens(tool));
    let hits = 0;
    for (const tok of qTokens) {
      if (nameTokens.has(tok)) {
        score += 8;
        hits += 1;
      } else if (capTokens.has(tok)) {
        // What the tool DOES, as classified — a better signal than its name.
        score += 6;
        hits += 1;
      } else if (descTokens.has(tok)) {
        score += 2;
        hits += 1;
      }
    }
    if (!hits) return 0;
    const readQuery =
      /\b(read|see|show|list|view|check|what|get|find|look|fetch|unread|inbox|summary|mail|email)\b/i.test(
        queryText,
      );
    if (readQuery && (consequence === "read" || consequence === "low")) score += 6;
    if (readQuery && /\b(send|delete|trash|create)\b/.test(name)) score -= 10;
  }
  return score;
}

function rankConnectedAppTools(tools, query = "", { requireQueryHit = false } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const q = String(query || "").trim();
  return list
    .map((tool, index) => ({ tool, index, score: scoreListedTool(tool, q) }))
    .filter((row) => (requireQueryHit && q ? row.score > 0 : true))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_TOOLS_PER_APP)
    .map((row) => row.tool);
}

function formatToolLine(tool) {
  const name = toolNameOf(tool) || "(unnamed)";
  const required = requiredOf(tool);
  const ready = required.length === 0 || required.every((key) => !isOpaqueArgKey(key) && key.toLowerCase() !== "id");
  const argNote = required.length
    ? ready
      ? `args: ${required.join(", ")}`
      : `needs ${required.join(", ")}`
    : "ready";
  const desc = String(tool.description || "").replace(/\s+/g, " ").slice(0, 110);
  return `  - ${name} (${tool.consequence || "read"}, ${argNote}) - ${desc}`;
}

/**
 * What KIND of thing the ask is about, as a semantic capability prefix.
 *
 * Word overlap alone is not enough to pick the right APP. An email search
 * that expanded "inbox" to "thread" started matching YouTube's comment-thread
 * tools, and because candidates were pooled across every connected app, a
 * request to check Gmail came back with YouTube. Capabilities say what a tool
 * is FOR — `communication.email.read` — so the app is chosen by what the user
 * asked about, and word scoring only orders the tools inside it.
 *
 * Grammar is <domain>.<resource>.<verb>; see lib/mcp/capabilityRegistry.js.
 */
const INTENT_CAPABILITIES = Object.freeze([
  { re: /\b(email|emails|inbox|unread|mailbox|mail|gmail|outlook)\b/i, prefix: "communication.email" },
  { re: /\b(slack|dm|dms|chat|channel|message|messages|conversation)\b/i, prefix: "communication.message" },
  { re: /\b(calendar|event|events|meeting|meetings|schedule|availability)\b/i, prefix: "calendar" },
  { re: /\b(doc|docs|document|documents|page|pages|note|notes|notion|wiki)\b/i, prefix: "documents" },
  { re: /\b(issue|issues|ticket|tickets|pr|pull request|commit|repo|repository|branch)\b/i, prefix: "source_control" },
  { re: /\b(task|tasks|project|projects|board|sprint|backlog)\b/i, prefix: "projects" },
  { re: /\b(contact|contacts|lead|leads|deal|deals|customer|account)\b/i, prefix: "crm" },
]);

/**
 * Does this CONNECTION serve one of these capability domains?
 *
 * Answered from `capabilitySummary.tools`, which the server computes at
 * discovery and returns with the connection list — so the question costs
 * nothing, and an email ask never has to read a video app's catalog to find
 * out it is a video app.
 */
function connectionServesCapability(conn, prefixes) {
  if (!prefixes.length) return false;
  const caps = conn?.capabilitySummary?.tools;
  // No summary (older connection, or a server that never classified) — do not
  // exclude it, or we would hide an app we simply know nothing about.
  if (!Array.isArray(caps) || !caps.length) return false;
  return caps.some((cap) => {
    const c = String(cap || "").toLowerCase();
    return prefixes.some((p) => c === p || c.startsWith(`${p}.`));
  });
}

/** Capability prefixes the ask implies, most specific first. */
function intentCapabilityPrefixes(text) {
  const t = String(text || "");
  return INTENT_CAPABILITIES.filter((row) => row.re.test(t)).map((row) => row.prefix);
}

/** Does any of this tool's capabilities sit under one of these prefixes? */
function toolMatchesCapability(tool, prefixes) {
  if (!prefixes.length) return false;
  const caps = Array.isArray(tool?.capabilities) ? tool.capabilities : [];
  return caps.some((cap) => {
    const c = String(cap || "").toLowerCase();
    return prefixes.some((p) => c === p || c.startsWith(`${p}.`));
  });
}

/** A read ask — "check my inbox", not "send this". */
function looksLikeReadAsk(text) {
  return /\b(read|see|show|list|view|check|what|get|find|look|fetch|unread|inbox|latest|recent|summar(?:y|ise|ize)|any\s+new)\b/i.test(
    String(text || ""),
  );
}

/**
 * A tool that can be called right now with no ids the model would have to
 * invent, and that only reads. The auto-call is limited to exactly this:
 * nothing consequential ever runs without the model choosing it explicitly.
 */
function isReadyReadTool(tool) {
  const consequence = String(tool?.consequence || "read").toLowerCase();
  if (consequence !== "read" && consequence !== "low") return false;
  const required = requiredOf(tool);
  if (required.some((key) => isOpaqueArgKey(key) || key.toLowerCase() === "id")) return false;
  const name = toolNameOf(tool).replace(/[^a-z0-9]+/gi, " ").toLowerCase();
  return /\b(list|search|fetch|get)\b/.test(name);
}

function createConnectedAppsTool({ mcpClient, apiBase, getAuthToken, logger = console }) {
  // The connection list is read by both the search and the call that follows
  // it; one turn does not need to ask twice.
  let connectionsPromise = null;
  async function listConnected() {
    if (!connectionsPromise) {
      connectionsPromise = mcpClient
        .listConnections({ apiBase, getAuthToken })
        .catch((e) => {
          connectionsPromise = null; // a failure must not be cached
          throw e;
        });
    }
    const connections = await connectionsPromise;
    return connections.filter((c) => c.status === "connected");
  }

  // Details are fetched once per tool instance and reused. Two things made
  // discovery stall: each app's tools were loaded one after another (eight
  // sequential round-trips for eight connected apps), and a query that
  // matched nothing re-ran the entire pass to build the fallback listing —
  // doubling it. Neither was visible as an error; the bot just sat there
  // "reading up on your tools".
  const detailCache = new Map();

  async function loadDetail(conn) {
    if (detailCache.has(conn.id)) return detailCache.get(conn.id);
    const promise = mcpClient
      .connectionDetail({ apiBase, getAuthToken, connectionId: conn.id })
      .catch((e) => {
        // Cache the failure too: a dead connector must not be retried once
        // per pass for the rest of the turn.
        detailCache.set(conn.id, { ok: false, error: e });
        throw e;
      });
    detailCache.set(conn.id, promise);
    return promise;
  }

  /** Every app's tools, loaded concurrently, failures isolated per app. */
  async function loadAllDetails(conns) {
    return Promise.all(
      conns.map(async (conn) => {
        try {
          const detail = await loadDetail(conn);
          if (detail && detail.ok === false && detail.error) throw detail.error;
          return { conn, detail, error: null };
        } catch (e) {
          return { conn, detail: null, error: e };
        }
      }),
    );
  }

  function formatAppSection(conn, tools, emptyNote) {
    const lines = (tools || []).map(formatToolLine);
    return `${conn.name} [app id: ${conn.id}]\n${lines.join("\n") || `  (${emptyNote})`}`;
  }

  async function runCatalog({ query = "", requireQueryHit = false }) {
    const usable = await listConnected();
    if (!usable.length) {
      return {
        ok: true,
        output:
          "No apps are connected. The user can connect Gmail, Slack, Notion, and more in Settings → Connections. Until then, the browser tool is the only way into their accounts.",
        summary: "No connected apps.",
      };
    }
    const sections = [];
    // Sections that are actually TOOLS, as opposed to "this app could not be
    // read". An error line counted as a section, so one failing connector
    // suppressed the no-match fallback and the answer became nothing but the
    // error — no tools at all, from apps that were working.
    let matchedSections = 0;
    // Ranked candidates across every app, so a search that has an obvious
    // answer can just take it instead of handing the model a menu.
    const candidates = [];
    // What the ask is ABOUT. When it names a domain and some connected app
    // actually serves it, only that app is considered — otherwise a query
    // that merely shares a word with another app's tools ("thread") can hand
    // back the wrong product entirely.
    const wantedCaps = intentCapabilityPrefixes(query);
    // Every connection already carries the semantic capabilities of its tools
    // (capabilitySummary.tools, set at discovery). So when the ask names a
    // domain we know which app serves it WITHOUT reading anybody's catalog —
    // and "check my email" stops fetching the full tool list of every other
    // connected app just to throw it away.
    const relevant = wantedCaps.length
      ? usable.filter((c) => connectionServesCapability(c, wantedCaps))
      : [];
    const toLoad = (relevant.length ? relevant : usable).slice(0, MAX_APPS_LISTED);
    if (relevant.length && relevant.length < usable.length) {
      logger.info?.(
        `[connected-apps] ${wantedCaps[0]} ask - reading ${relevant.length} of ${usable.length} connected app(s)`,
      );
    }
    const loaded = await loadAllDetails(toLoad);
    for (const { conn, detail, error } of loaded) {
      if (error) {
        logger.warn?.(`[connected-apps] detail failed connection=${conn.id}: ${error?.message || error}`);
        sections.push(
          `${conn.name} [app id: ${conn.id}]\n  (tools could not be loaded this time${
            error?.code === "mcp_timeout" ? " - it did not respond" : ""
          } - retry the search; do not switch to the browser while this app is connected)`,
        );
        continue;
      }
      const allTools = detail?.tools || [];
      // A tool classified under the asked-for domain is on-topic regardless
      // of what it happens to be named.
      const onTopic = wantedCaps.length
        ? allTools.filter((t) => toolMatchesCapability(t, wantedCaps))
        : [];
      const ranked = onTopic.length
        ? rankConnectedAppTools(onTopic, query, { requireQueryHit: false })
        : rankConnectedAppTools(allTools, query, { requireQueryHit });
      for (const tool of ranked) {
        candidates.push({ conn, tool, onTopic: onTopic.length > 0 });
      }
      if (requireQueryHit && !ranked.length) continue;
      if (ranked.length) matchedSections += 1;
      sections.push(
        formatAppSection(
          conn,
          ranked,
          query
            ? "no matching tools - try a shorter action phrase"
            : "no tools discovered",
        ),
      );
    }
    // If some connected app actually serves the domain the user asked about,
    // no other app's tools belong in the answer at all.
    const domainMatched = candidates.filter((c) => c.onTopic);
    if (wantedCaps.length && domainMatched.length) {
      candidates.length = 0;
      candidates.push(...domainMatched);
      const keepIds = new Set(domainMatched.map((c) => c.conn.id));
      const kept = sections.filter((sec) =>
        [...keepIds].some((id) => sec.includes(`[app id: ${id}]`)),
      );
      if (kept.length) {
        sections.length = 0;
        sections.push(...kept);
      }
    }

    // Nothing matched the words used — but the app IS connected, so the way
    // in exists and the search phrasing is the only thing that failed. Coming
    // back empty made the bot report that it could not reach a working
    // mailbox: verify failed the round, the retry rephrased and missed again,
    // and it gave up. Fall back to the ranked entry points instead; the
    // scorer already floats ready list/search/fetch tools to the top, which
    // is exactly what an unmatched query needs.
    if (!matchedSections && query) {
      // Re-ranks the details already in hand; no second pass over the network.
      const fallback = await runCatalog({ query: "", requireQueryHit: false });
      if (fallback.summary !== "No connected apps.") {
        return {
          ...fallback,
          output: [
            `Nothing matched "${query}" by name, so here is every connected app's best entry points.`,
            "Pick the closest ready list/search/fetch tool and call it - do NOT switch to the browser, and do not report the app as unreachable.",
            "",
            fallback.output,
          ].join("\n"),
          summary: `No name match for "${query}" - listed entry points instead.`,
        };
      }
    }
    if (!sections.length) {
      return {
        ok: true,
        output: [
          "Connected apps are available, but no catalog tool matched that search.",
          "Retry with a shorter action (unread mail, list messages, send email). Do not use the browser while the app is connected.",
          'Call one with: {"app": "<app id or name>", "tool": "<TOOL_NAME>", "args": { ... }}',
        ].join("\n"),
        summary: "No matching connected-app tools.",
      };
    }
    return {
      ok: true,
      candidates,
      output: [
        query
          ? `Connected-app tools matching "${query}" (prefer ready list/search/fetch tools; do not invent names):`
          : "Connected apps and their callable tools (ranked discovery entry points, not the full catalog):",
        "",
        ...sections,
        "",
        'Call one with: {"app": "<app id or name>", "tool": "<TOOL_NAME>", "args": { ... }}',
        "Prefer a ready tool. Tools marked `needs …_id` are the wrong first call.",
      ].join("\n"),
      summary: query ? `Search listed ${sections.length} app(s).` : `${usable.length} connected app(s) listed.`,
    };
  }

  async function callTool({ connection, toolMeta, tool, args, approvalToken, signal }) {
    return mcpClient.callTool({
      apiBase,
      getAuthToken,
      connectionId: connection.id,
      toolName: tool,
      args,
      approvalToken,
      task: {
        objective: `connected_apps: ${tool}`,
        capabilities: toolMeta?.capabilities || [],
        association: { connectionIds: [connection.id] },
        cancellation: { state: signal?.aborted ? "cancelled" : "active" },
      },
    });
  }

  async function runCall({ app, tool, args, signal, requestApproval }) {
    const usable = await listConnected();
    const connection = matchConnection(usable, app);
    if (!connection) {
      return {
        ok: false,
        output: `No connected app matches "${app}". Run the tool with "list" to see what is connected.`,
        summary: "App not found.",
      };
    }
    let toolMeta = null;
    try {
      // Through the cache: the search that produced this tool name has almost
      // always just read this app's catalog, and re-reading it made every
      // connected-app call pay a second full round-trip in series.
      const detail = await loadDetail(connection);
      toolMeta = findListedTool(detail?.tools || [], tool);
    } catch {
      toolMeta = null;
    }
    if (!toolMeta) {
      return {
        ok: false,
        output: `${connection.name} has no tool named ${tool}. Search with a short action phrase (unread mail, list messages) for exact tool names. Do not use the browser while this app is connected.`,
        summary: "Tool not found.",
      };
    }
    const resolvedName = toolNameOf(toolMeta);

    let result = await callTool({ connection, toolMeta, tool: resolvedName, args, signal });
    if (result?.status === "waiting_for_approval" && result.approvalToken) {
      if (typeof requestApproval !== "function") {
        // Headless run (routine): consequential calls never auto-approve.
        return {
          ok: false,
          output: `${resolvedName} in ${connection.name} has real effects and needs the user's approval, which is not available in this run. Skip it and report what you found instead.`,
          summary: "Approval unavailable in this run.",
        };
      }
      const summary = result.request?.summary || result.request?.title || "";
      const question =
        String(summary || "").trim() ||
        `Approve ${resolvedName} in ${connection.name}? This action has real effects.`;
      const approved = await requestApproval({ question });
      if (!approved) {
        return {
          ok: false,
          output: `The user declined ${resolvedName} in ${connection.name}. Do not retry it.`,
          summary: "Declined by user.",
        };
      }
      result = await callTool({
        connection,
        toolMeta,
        tool: resolvedName,
        args,
        approvalToken: result.approvalToken,
        signal,
      });
    }
    if (signal?.aborted) return { ok: false, output: "", summary: "cancelled" };

    if (result?.status === "waiting_for_user" || result?.condition === "connection_auth_required") {
      return {
        ok: false,
        output: `${connection.name} needs to be reconnected in Settings → Connections before its tools work.`,
        summary: "Connection needs attention.",
      };
    }
    if (result?.ok === false) {
      const reason = String(result.reason || "error");
      const hint =
        reason === "tool_not_in_resolution"
          ? ` ${resolvedName} is on ${connection.name}; retry a ready list/search/fetch tool from the listing. Do not switch to the browser.`
          : "";
      return {
        ok: false,
        output: boundOutput(`${result.reason || result}${hint}`),
        summary: `Call failed: ${reason.slice(0, 120)}`,
      };
    }
    const observation = result?.observation ?? result;
    return {
      ok: true,
      output: boundOutput(observation),
      summary: `${resolvedName} in ${connection.name} succeeded.`,
    };
  }

  /**
   * A catalog search is discovery, not an answer — and the harness verifies
   * every tool run against the instruction it was given. So a bot asked to
   * "check my email" would search, get a list of tool NAMES back, have that
   * judged as not accomplishing the instruction, burn a recovery, search
   * again, burn the last one, and deliver "I could not complete a fresh
   * inbox check" — having never once called a tool it could see.
   *
   * When the search has an obvious answer, take it: one ready READ tool that
   * needs no ids, for a read ask. Nothing consequential is ever auto-called;
   * sending, deleting and posting stay an explicit choice the model makes and
   * the approval gate sees.
   */
  async function maybeAutoCall(found, { ask, signal, requestApproval }) {
    const candidates = Array.isArray(found?.candidates) ? found.candidates : [];
    if (!found?.ok || !candidates.length) return withFollowUpFlag(found);
    if (!looksLikeReadAsk(ask)) return withFollowUpFlag(found);
    // Only auto-call inside the app the ask is actually about. Without this,
    // "check my email" could run a YouTube search because it happened to rank
    // first among pooled candidates.
    const wanted = intentCapabilityPrefixes(ask);
    const pool = wanted.length ? candidates.filter((c) => c.onTopic) : candidates;
    if (wanted.length && !pool.length) return withFollowUpFlag(found);
    const pick = pool.find((c) => isReadyReadTool(c.tool));
    if (!pick) return withFollowUpFlag(found);

    const toolName = toolNameOf(pick.tool);
    logger.info?.(`[connected-apps] auto-calling ${pick.conn.name}/${toolName} for a read ask`);
    let called;
    try {
      called = await runCall({
        app: pick.conn.id,
        tool: toolName,
        args: {},
        signal,
        requestApproval,
      });
    } catch (e) {
      logger.warn?.(`[connected-apps] auto-call failed ${toolName}: ${e?.message || e}`);
      return withFollowUpFlag(found);
    }
    // A failed auto-call is not a dead end: hand back the listing so the model
    // can pick a different tool or supply arguments itself.
    if (!called || called.ok === false) {
      return withFollowUpFlag({
        ...found,
        output: [
          `Tried ${toolName} automatically and it did not return data` +
            `${called?.summary ? ` (${called.summary})` : ""}.`,
          "Pick another tool below, or call the same one with arguments.",
          "",
          found.output,
        ].join("\n"),
      });
    }
    return {
      ...called,
      // The tool ran and returned the user's own data. Asking a model
      // afterwards whether that counts as checking their email is a full
      // round-trip spent re-reading what is already in hand.
      verified: true,
      summary: called.summary || `Read ${pick.conn.name} via ${toolName}.`,
    };
  }

  /**
   * Mark a discovery result as a STEP rather than an attempt at the goal, so
   * the harness does not verify it against the instruction and does not spend
   * a recovery on it. Without this, two searches exhaust the retry budget
   * before the first real call is ever made.
   */
  function withFollowUpFlag(found) {
    if (!found || found.ok === false) return found;
    if (found.summary === "No connected apps.") return found;
    return {
      ...found,
      needsFollowUp: true,
      output: [
        found.output,
        "",
        "This was discovery, not the answer. Call one of the tools above NOW with",
        '{"app": "<app id>", "tool": "<TOOL_NAME>", "args": { ... }} to get the actual data.',
      ].join("\n"),
    };
  }

  async function execute({ instruction, signal, requestApproval, goal } = {}) {
    if (signal?.aborted) return { ok: false, output: "", summary: "cancelled" };
    const parsed = parseInstruction(instruction);
    try {
      if (parsed.mode === "call") return await runCall({ ...parsed, signal, requestApproval });
      const hint = String(goal || "").trim();
      if (parsed.mode === "search") {
        const found = await runCatalog({ query: parsed.query, requireQueryHit: true });
        return await maybeAutoCall(found, {
          ask: `${parsed.query} ${hint}`.trim(),
          signal,
          requestApproval,
        });
      }
      // Bare "list": if this task already named the work, search for that
      // instead of dumping an unrelated slice of a large catalog.
      if (hint) {
        const searched = await runCatalog({ query: hint, requireQueryHit: true });
        if (searched.summary !== "No matching connected-app tools.") return searched;
      }
      return await runCatalog({ query: "", requireQueryHit: false });
    } catch (e) {
      if (e?.code === "sign_in_required") {
        return { ok: false, output: "The user must be signed in to use connected apps.", summary: "Sign-in required." };
      }
      logger.warn?.(`[connected-apps] failed: ${e?.message || e}`);
      return {
        ok: false,
        output: `Connected apps are unavailable right now (${String(e?.message || "error").slice(0, 140)}).`,
        summary: "Connected apps unavailable.",
      };
    }
  }

  return { execute };
}

module.exports = {
  createConnectedAppsTool,
  parseInstruction,
  matchConnection,
  rankConnectedAppTools,
  findListedTool,
};
