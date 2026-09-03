/**
 * ExternalToolResolver
 *
 * Ranking:
 *   1. explicit connectionId
 *   2. Bot/Routine allowed connections
 *   3. capability match
 *   4. account relevance
 *   5. trust
 *   6. tool confidence
 *
 * Model descriptions cannot select unauthorized connections.
 * Ambiguous consequential writes do not guess an account.
 *
 * First-party GitHub tools remain outside this resolver. If a GitHub MCP
 * connection is also present, this resolver only discloses the MCP tools
 * when the Task needs source_control and the connection is allowed. It
 * does not hide first-party GitHub tools; chat/runtime must not add the
 * same GitHub MCP tools twice. If both are plausible and no connection
 * is assigned, prefer the explicit connectionId; otherwise leave
 * first-party GitHub in the first-party set and omit MCP GitHub until
 * the user assigns it.
 */

import { MCP_BOUNDS } from './bounds.js';
import {
  capabilitySatisfies,
  CONSEQUENCE,
  isWriteVerb,
  parseCapability,
  writeRequiresExplicitConnection,
} from './capabilityRegistry.js';
import { inferCapabilityNeeds } from './inferCapabilityNeed.js';
import { AUTH_REQUIRED_STATUSES, MCP_STATUSES, MCP_TRUST_LEVELS } from './protocol.js';
import { searchExternalToolIndex, buildExternalToolIndex } from './toolIndex.js';
import { suggestCatalogForCapabilities } from './catalog/curated.js';

const TRUST_SCORE = {
  [MCP_TRUST_LEVELS.OFFICIAL]: 4,
  [MCP_TRUST_LEVELS.VERIFIED]: 3,
  [MCP_TRUST_LEVELS.ENTERPRISE]: 3,
  [MCP_TRUST_LEVELS.COMMUNITY]: 1,
  [MCP_TRUST_LEVELS.CUSTOM]: 0,
  [MCP_TRUST_LEVELS.REMOTE]: 0,
  [MCP_TRUST_LEVELS.LOCAL_TRUSTED]: 1,
};

function connectionAllowlist(task, botConnectionIds) {
  if (Array.isArray(task?.association?.connectionIds)) {
    return task.association.connectionIds.map(String);
  }
  if (Array.isArray(botConnectionIds)) return botConnectionIds.map(String);
  return null;
}

function filterConnections(connections, allowlist) {
  const list = Array.isArray(connections) ? connections : [];
  if (!allowlist) return list;
  const set = new Set(allowlist);
  return list.filter((conn) => set.has(String(conn.id)));
}

/**
 * Does the turn's text name this connection? Matches on connection
 * name/label/identity tokens, and on a whitespace-squashed form so
 * "mail chimp" still names the Mailchimp connection.
 */
function connectionMentionedIn(conn, textLower) {
  if (!conn || !textLower) return false;
  const squashed = textLower.replace(/[^a-z0-9]+/g, '');
  const labels = [conn.name, conn.accountLabel, conn.accountIdentity].filter(Boolean).map(String);
  for (const label of labels) {
    const labelLower = label.toLowerCase();
    if (labelLower.length >= 3 && textLower.includes(labelLower)) return true;
    const labelSquashed = labelLower.replace(/[^a-z0-9]+/g, '');
    if (labelSquashed.length >= 4 && squashed.includes(labelSquashed)) return true;
    for (const token of labelLower.split(/[^a-z0-9@.]+/)) {
      if (token.length >= 4 && new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(textLower)) {
        return true;
      }
    }
  }
  return false;
}

// Read vs write phrasing in the objective, used to bias mention-only ranking
// (needs carry the verb for rule-matched domains, but a named app with no
// domain rule has nothing else to say which of its hundreds of tools fit).
const READ_INTENT_RE = /\b(read|see|show|list|view|check|what|which|get|find|look|fetch|pull|summarize|summarise)\b/i;
const WRITE_INTENT_RE = /\b(add|create|update|send|delete|remove|write|edit|set|upload|post|publish|schedule)\b/i;

/** Match "campaigns" to CAMPAIGN tools: compare tokens with plural stripped. */
function stemToken(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

// Provider-shipped experimental/legacy endpoint variants (Supabase alone has
// dozens of ALPHA_*/BETA_* near-duplicates). They tie with the stable tool on
// every other signal and then win alphabetically, flooding the disclosure cap.
const EXPERIMENTAL_NAME_RE = /\b(alpha|beta|deprecated|legacy|experimental)\b/i;

function scoreTool(classified, needs, conn, { explicitConnection, objective, mentioned } = {}) {
  let score = 0;
  const toolNameText = String(classified.toolName || classified.serverToolName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  // Need satisfaction counts ONCE (best match), not per need: read tools
  // satisfy both `x.read` and `x.search`, and summing let them double-score
  // and flood the disclosure cap, crowding out the write tools the task
  // actually asked for.
  let needScore = 0;
  let domainMatch = false;
  for (const cap of classified.semanticCapabilities || classified.capabilities || []) {
    const have = parseCapability(cap);
    for (const need of needs) {
      const want = parseCapability(need);
      if (capabilitySatisfies(cap, need)) {
        const exact = have && want && have.verb === want.verb;
        needScore = Math.max(needScore, exact ? 12 : 10);
      }
      if (have && want && have.domain === want.domain) domainMatch = true;
    }
  }
  // Trust, confidence, and domain proximity are tiebreakers, not
  // qualifications: a tool that satisfies none of the needs must not rank —
  // UNLESS the user named this app. A named connected app's tools are
  // disclosed even when no domain rule matched ("can you see my mailchimp
  // account" — mailchimp has no capability rule and never will need one).
  // The mention base (8) stays below any need match (10+) so it never
  // outranks tools the task actually asked for. Execution gates are
  // unchanged: consequential calls still require live approval.
  if (!needScore) {
    if (!mentioned) return 0;
    score += 8;
    // With hundreds of tools tying at the mention base, alphabetical order
    // decided the disclosure cap — "read my mailchimp campaigns" got ten
    // ADD_* tools and no campaign reader. Align the tool's consequence with
    // the phrasing so read asks fill with read tools and write asks with
    // write tools.
    const consequence = classified.consequenceHint || classified.consequence;
    const isReadTool = consequence === CONSEQUENCE.READ;
    if (READ_INTENT_RE.test(objective) && isReadTool) {
      score += 3;
      // Discovery entry points first: "can you see my supabase project"
      // needs LIST_ALL_PROJECTS before the dozens of GET_PROJECT_* tools
      // that all require an identifier the model does not have yet.
      if (/\b(list|search)\b/.test(toolNameText)) score += 2;
    }
    if (WRITE_INTENT_RE.test(objective) && !isReadTool) score += 3;
  } else {
    score += needScore;
  }
  if (EXPERIMENTAL_NAME_RE.test(toolNameText)) score -= 2;
  if (domainMatch) score += 3;
  // Objective/name token overlap breaks ties between same-capability tools
  // ("send an email" prefers GMAIL_SEND_EMAIL over GMAIL_PATCH_SEND_AS).
  // Tokens are plural-stemmed so "campaigns" matches CAMPAIGN tools.
  const objectiveTokens = new Set(
    String(objective || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
      .map(stemToken),
  );
  let overlap = 0;
  for (const token of new Set(toolNameText.split(' ').map(stemToken))) {
    if (objectiveTokens.has(token)) overlap += 1;
  }
  score += Math.min(3, overlap);
  if (explicitConnection && String(conn.id) === String(explicitConnection)) score += 20;
  // The app the user is talking about (this message OR recent turns) outranks
  // same-scored tools from other connected apps.
  if (mentioned) score += 2;
  score += TRUST_SCORE[conn.trustLevel] || 0;
  score += classified.confidence || 0;
  return score;
}

export function resolveExternalTools({
  task,
  needs,
  connections,
  classifiedByConnectionId,
  botConnectionIds,
  contextText,
  maxTools = MCP_BOUNDS.MAX_TOOLS_PER_DISCLOSURE,
} = {}) {
  const objective = String(task?.objective || '');
  const mentionTextLower = `${objective}\n${String(contextText || '')}`.toLowerCase();
  const resolvedNeeds =
    Array.isArray(needs) && needs.length
      ? needs
      : inferCapabilityNeeds(objective, { explicit: task?.capabilities });

  // No inferred needs normally means no external work — but a turn that NAMES
  // a connected app ("can you see my mailchimp account") is asking about that
  // app, whether or not any domain rule matches it. Only bail when neither
  // needs nor a mention exist.
  const anyMention = (connections || []).some(
    (conn) => conn.status === MCP_STATUSES.CONNECTED && connectionMentionedIn(conn, mentionTextLower),
  );
  if (!resolvedNeeds.length && !anyMention) {
    return {
      ok: true,
      tools: [],
      needs: [],
      reason: 'no_external_need',
      ambiguous: false,
    };
  }

  const allowlist = connectionAllowlist(task, botConnectionIds);
  if (allowlist && allowlist.length === 0) {
    return {
      ok: false,
      tools: [],
      needs: resolvedNeeds,
      reason: 'bot_connection_restricted',
      ambiguous: false,
    };
  }

  const scoped = filterConnections(connections, allowlist);
  const eligible = scoped.filter((conn) => conn.status === MCP_STATUSES.CONNECTED);
  const authBlocked = scoped.filter((conn) => AUTH_REQUIRED_STATUSES.includes(conn.status));
  const unavailable = scoped.filter(
    (conn) => conn.status && conn.status !== MCP_STATUSES.CONNECTED && !AUTH_REQUIRED_STATUSES.includes(conn.status),
  );

  if (allowlist && allowlist.length && !eligible.length) {
    const referenced = scoped[0] || connections?.find((c) => allowlist.includes(String(c.id)));
    if (referenced && AUTH_REQUIRED_STATUSES.includes(referenced.status)) {
      return {
        ok: false,
        tools: [],
        needs: resolvedNeeds,
        reason: 'connection_auth_required',
        condition: 'connection_auth_required',
        connectionId: referenced.id,
        ambiguous: false,
      };
    }
    if (referenced && referenced.status !== MCP_STATUSES.CONNECTED) {
      return {
        ok: false,
        tools: [],
        needs: resolvedNeeds,
        reason: 'connection_required',
        condition: 'connection_required',
        connectionId: referenced.id,
        ambiguous: false,
      };
    }
  }

  const explicitConnection =
    Array.isArray(task?.association?.connectionIds) && task.association.connectionIds.length === 1
      ? String(task.association.connectionIds[0])
      : null;

  const index = buildExternalToolIndex(eligible, classifiedByConnectionId);
  const ranked = [];
  for (const conn of eligible) {
    const classified = classifiedByConnectionId?.[conn.id] || conn.classifiedTools || [];
    const mentioned = connectionMentionedIn(conn, mentionTextLower);
    for (const tool of classified) {
      const score = scoreTool(tool, resolvedNeeds, conn, {
        explicitConnection,
        objective,
        mentioned,
      });
      // scoreTool returns 0 for tools that neither satisfy a need nor belong
      // to an app the user named; any positive score is a deliberate rank.
      if (score <= 0) continue;
      ranked.push({
        connectionId: conn.id,
        connectionName: conn.name,
        accountLabel: conn.accountLabel,
        accountIdentity: conn.accountIdentity,
        trustLevel: conn.trustLevel,
        toolName: tool.toolName || tool.serverToolName,
        semanticCapabilities: tool.semanticCapabilities || tool.capabilities,
        consequenceHint: tool.consequenceHint || tool.consequence,
        consequence: tool.consequence || tool.consequenceHint,
        confidence: tool.confidence,
        description: tool.description,
        inputSchema: tool.inputSchema,
        schemaFingerprint: tool.schemaFingerprint,
        classifierVersion: tool.classifierVersion,
        score,
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  // "Ambiguous consequential writes do not guess an account" applies PER
  // NEED: block only when the SAME write need is satisfiable by write tools
  // on more than one account (e.g. two Gmail accounts for one send). A task
  // whose write needs each map to exactly one connected app ("append to my
  // Notion doc and email it") is not ambiguous, and a read-only turn must
  // never be blocked just because write-capable tools exist somewhere.
  let ambiguousWrite = null;
  if (!explicitConnection) {
    // An app the user NAMES resolves the ambiguity for that need — matching
    // on connection name/label tokens. Follow-up turns rarely repeat the app
    // ("can you add a pitch idea" after "my pitches doc in notion"), so the
    // recent conversation counts as naming it too.
    const connectionMentioned = (connectionId) =>
      connectionMentionedIn(
        eligible.find((c) => String(c.id) === String(connectionId)),
        mentionTextLower,
      );
    const writeNeeds = resolvedNeeds.filter((need) => isWriteVerb(parseCapability(need)?.verb));
    for (const need of writeNeeds) {
      const accountsForNeed = new Map();
      for (const item of ranked) {
        if (!writeRequiresExplicitConnection(item.consequenceHint)) continue;
        if (!(item.semanticCapabilities || []).some((cap) => capabilitySatisfies(cap, need))) continue;
        const list = accountsForNeed.get(item.connectionId) || [];
        list.push(item);
        accountsForNeed.set(item.connectionId, list);
      }
      if (accountsForNeed.size <= 1) continue;
      const mentioned = [...accountsForNeed.keys()].filter(connectionMentioned);
      if (mentioned.length === 1) {
        // Named app wins: drop this need's write tools on the other accounts.
        const keep = String(mentioned[0]);
        for (let i = ranked.length - 1; i >= 0; i -= 1) {
          const item = ranked[i];
          if (String(item.connectionId) === keep) continue;
          if (!writeRequiresExplicitConnection(item.consequenceHint)) continue;
          if ((item.semanticCapabilities || []).some((cap) => capabilitySatisfies(cap, need))) {
            ranked.splice(i, 1);
          }
        }
        continue;
      }
      // Genuinely ambiguous: DEGRADE instead of nuking the turn. Drop this
      // need's write tools (never guess an account for a write) but keep the
      // read/search tools working, and surface the candidates so the model
      // can ask the user which account to use.
      ambiguousWrite = {
        need,
        candidates: [...accountsForNeed.entries()].map(([id, tools]) => ({
          connectionId: id,
          connectionName: tools[0]?.connectionName,
          accountLabel: tools[0]?.accountLabel,
          accountIdentity: tools[0]?.accountIdentity,
          toolNames: tools.map((t) => t.toolName).slice(0, 8),
        })),
      };
      for (let i = ranked.length - 1; i >= 0; i -= 1) {
        const item = ranked[i];
        if (!writeRequiresExplicitConnection(item.consequenceHint)) continue;
        if ((item.semanticCapabilities || []).some((cap) => capabilitySatisfies(cap, need))) {
          ranked.splice(i, 1);
        }
      }
    }
  }

  if (ambiguousWrite && !ranked.length) {
    return {
      ok: false,
      tools: [],
      needs: resolvedNeeds,
      reason: 'ambiguous_account',
      ambiguous: true,
      candidates: ambiguousWrite.candidates,
    };
  }

  // Reserve a slot for the best tool of each satisfied need before filling
  // by score. Read tools satisfy both read and search needs, so on a send
  // task they would otherwise crowd the single send tool out of the cap.
  const cap = Math.max(1, maxTools);
  const toolKey = (item) => `${item.connectionId}::${item.toolName}`;
  const reserved = new Set();
  const limited = [];
  const verbMatchesExactly = (item, need) => {
    const want = parseCapability(need);
    return (item.semanticCapabilities || []).some((cap) => {
      const have = parseCapability(cap);
      if (!have || !want || !capabilitySatisfies(cap, need)) return false;
      if (want.verb === 'write') return ['write', 'create', 'update'].includes(have.verb);
      return have.verb === want.verb;
    });
  };
  for (const need of resolvedNeeds) {
    if (limited.length >= cap) break;
    // Prefer a tool whose verb matches the need exactly: a `documents.search`
    // slot should hold a search tool, not a read tool that merely qualifies.
    // Among exact matches, a name that literally carries the verb wins the
    // tie (SEARCH_NOTION_PAGE over GET_VIEW_QUERY_RESULTS for a search need).
    const wantVerb = parseCapability(need)?.verb || '';
    const open = (item) => !reserved.has(toolKey(item));
    const best =
      (wantVerb &&
        ranked.find(
          (item) =>
            open(item) &&
            verbMatchesExactly(item, need) &&
            String(item.toolName || '').toLowerCase().includes(wantVerb),
        )) ||
      ranked.find((item) => open(item) && verbMatchesExactly(item, need)) ||
      ranked.find(
        (item) =>
          open(item) &&
          (item.semanticCapabilities || []).some((have) => capabilitySatisfies(have, need)),
      );
    if (best) {
      reserved.add(toolKey(best));
      limited.push(best);
    }
  }
  for (const item of ranked) {
    if (limited.length >= cap) break;
    if (reserved.has(toolKey(item))) continue;
    reserved.add(toolKey(item));
    limited.push(item);
  }
  limited.sort((a, b) => b.score - a.score);
  if (!limited.length) {
    const suggestions = suggestCatalogForCapabilities(resolvedNeeds).slice(0, 3).map((entry) => ({
      catalogId: entry.id,
      name: entry.name,
      trust: entry.trust,
      source: entry.source,
      capabilities: entry.capabilities,
    }));
    return {
      ok: false,
      tools: [],
      needs: resolvedNeeds,
      reason: 'missing_capability',
      condition: 'missing_capability',
      missingCapabilities: resolvedNeeds,
      suggestions,
      ambiguous: false,
    };
  }
  return {
    ok: true,
    tools: limited,
    needs: resolvedNeeds,
    reason: limited.length ? 'resolved' : 'no_matching_tools',
    ambiguous: Boolean(ambiguousWrite),
    ...(ambiguousWrite ? { candidates: ambiguousWrite.candidates, ambiguousNeed: ambiguousWrite.need } : {}),
    indexHits: searchExternalToolIndex(index, resolvedNeeds).length,
    unavailable: [
      ...unavailable.map((conn) => ({ connectionId: conn.id, name: conn.name, status: conn.status })),
      ...authBlocked.map((conn) => ({
        connectionId: conn.id,
        name: conn.name,
        status: conn.status,
        condition: 'connection_auth_required',
      })),
    ],
  };
}

export function findResolvedTool(resolution, { connectionId, toolName } = {}) {
  const tools = resolution?.tools || [];
  return (
    tools.find(
      (tool) =>
        (!connectionId || tool.connectionId === connectionId) &&
        (!toolName || tool.toolName === toolName),
    ) || null
  );
}

export { CONSEQUENCE };
