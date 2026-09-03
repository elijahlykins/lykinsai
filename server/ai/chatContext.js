// Chat context builders: project section, connected-tools section, custom models.
// `projectSectionCache` and `connectedToolsSectionCache` are process singletons.
//
// Context composition / cache identity lives in server/ai/contextPipeline.
// This file stays the owner of project + connected-tools prompt sections.
import {
  formatProjectStateForPromptInLykn,
  formatOtherProjectsForPromptOutsideClient,
  loadActiveProjectContext,
  loadProjectContextById,
  loadOtherProjectsForUser,
} from '../../lib/projectContext.js';
import { loadCustomModelVaultKnowledgeSection } from '../../lib/modelBuilder/customModelKnowledge.js';
import { resolveCustomModelChatContext } from '../../lib/modelBuilder/customModelChat.js';
import { isTogetherInferenceModel } from '../../lib/lora/togetherLora.js';
import { isModelAllowedForPlan } from '../../src/lib/modelTiers.js';
import { createSynthesisUserClient } from './chatRetrieval.js';
import { normalizeRequestedModel } from './modelInvoke.js';

let supabaseAdmin = null;

export function bindChatContext(deps) {
  supabaseAdmin = deps.supabaseAdmin;
}

export const PROJECT_SECTION_CACHE_TTL_MS = 90 * 1000;
const projectSectionCache = new Map();

export function invalidateProjectSectionCache(userId) {
  if (!userId) return;
  for (const key of projectSectionCache.keys()) {
    if (key === userId || key.startsWith(`${userId}:`)) projectSectionCache.delete(key);
  }
}

// ──────────────────────────────────────────────────────────────────────
// CONNECTED TOOLS — what external services the user has actively linked.
//
// The chat AI needs to know which apps the user has connected so it can
// give specific, actionable suggestions ("save that to your Notion",
// "drop a Linear ticket for this") instead of generic ones. We cache
// per user for ~90s so chat sends don't hit Supabase every turn;
// `/api/connections` mutations call `invalidateConnectedToolsCache` so
// freshly connected/disconnected tools surface on the next chat turn.
// ──────────────────────────────────────────────────────────────────────
export const CONNECTED_TOOLS_CACHE_TTL_MS = 90 * 1000;
export const CONNECTED_TOOLS_SECTION_MAX_CHARS = 2500;
const connectedToolsSectionCache = new Map();

export function invalidateConnectedToolsCache(userId) {
  if (userId) connectedToolsSectionCache.delete(userId);
}

// Provider id → { name, hint } for any leftover display labels.
// External live data now comes from Universal MCP, not connector sync.
export const CONNECTED_TOOL_DESCRIPTORS = {
  notion: { name: 'Notion', hint: 'save pages, notes, or docs into their Notion workspace' },
  gmail: { name: 'Gmail', hint: 'draft an email or reference inbox / starred messages' },
  'outlook-365': { name: 'Outlook', hint: 'draft an email or reference inbox messages' },
  slack: { name: 'Slack', hint: 'share a message or pull recent threads' },
  github: { name: 'GitHub', hint: 'reference repos, issues, or PRs' },
  linear: { name: 'Linear', hint: 'create or reference an issue / project' },
  todoist: { name: 'Todoist', hint: 'capture a task into their inbox' },
  trello: { name: 'Trello', hint: 'add a card to a board' },
  'google-drive': { name: 'Google Drive', hint: 'save a doc / file or reference a synced file' },
  'google-calendar': { name: 'Google Calendar', hint: 'add an event or reference upcoming events' },
  'apple-calendar': { name: 'Apple Calendar', hint: 'add an event or reference upcoming events' },
  youtube: { name: 'YouTube', hint: 'pull saved / liked videos or watch history' },
  spotify: { name: 'Spotify', hint: 'reference saved tracks, albums, or playlists' },
  pinterest: { name: 'Pinterest', hint: 'reference saved pins or boards' },
  vimeo: { name: 'Vimeo', hint: 'reference saved / uploaded videos' },
  raindrop: { name: 'Raindrop', hint: 'capture a bookmark or reference saved highlights' },
  dribbble: { name: 'Dribbble', hint: 'reference saved design inspiration' },
  reddit: { name: 'Reddit', hint: 'reference saved posts' },
  x: { name: 'X (Twitter)', hint: 'reference saved / bookmarked posts' },
  mastodon: { name: 'Mastodon', hint: 'reference favourited / bookmarked posts' },
  bluesky: { name: 'Bluesky', hint: 'reference recent posts' },
  readwise: { name: 'Readwise', hint: 'reference book / article highlights' },
  hackernews: { name: 'Hacker News', hint: 'reference upvoted / saved stories' },
  lastfm: { name: 'Last.fm', hint: 'reference recent listening history' },
  pinboard: { name: 'Pinboard', hint: 'reference saved bookmarks' },
  hardcover: { name: 'Hardcover', hint: 'reference current reading / library' },
  karakeep: { name: 'Karakeep', hint: 'reference saved bookmarks' },
  linkding: { name: 'Linkding', hint: 'reference saved bookmarks' },
  goodreads: { name: 'Goodreads', hint: 'reference current reading / shelves' },
  'amazon-wishlist': { name: 'Amazon Wishlist', hint: 'reference saved wishlist items' },
  canva: { name: 'Canva', hint: 'reference saved designs' },
};

/**
 * Build a `[CONNECTED_TOOLS]` prompt block for remaining custom API
 * connections. Live Gmail/Slack/etc. access is Universal MCP, not
 * connector-to-Vault sync. Returns empty string when the user has none.
 */
export async function fetchConnectedToolsSection(authHeader, userId) {
  if (!userId) return '';
  const cached = connectedToolsSectionCache.get(userId);
  if (cached && Date.now() - cached.at < CONNECTED_TOOLS_CACHE_TTL_MS) {
    return cached.text;
  }

  const client = createSynthesisUserClient(authHeader) || supabaseAdmin;
  if (!client) {
    connectedToolsSectionCache.set(userId, { text: '', at: Date.now() });
    return '';
  }

  const rows = [];

  // Custom API connections (universal bring-your-own-key apps). These are
  // ACTIONABLE via lykn_call_app, not connector-synced sources.
  let customConns = [];
  try {
    const { data } = await client
      .from('lykn_custom_connections')
      .select('name, slug, base_url, description, allow_writes, status')
      .eq('user_id', userId)
      .eq('status', 'active');
    if (Array.isArray(data)) customConns = data;
  } catch (e) {
    console.warn('⚠️ fetchConnectedToolsSection custom:', e?.message || e);
  }

  const oauthActionApps = [];

  // Managed OAuth apps (Settings → Connections). Their tools surface as
  // connected-app (MCP) tools on the turn; this block gives the model
  // standing awareness of what is connected even before a tool need is
  // inferred, so it reaches for the OAuth tools instead of the browser.
  let managedApps = [];
  try {
    const { data } = await client
      .from('lykn_mcp_connections')
      .select('name, status')
      .eq('user_id', userId)
      .eq('provided_through', 'composio')
      .neq('status', 'disconnected');
    if (Array.isArray(data)) managedApps = data;
  } catch (e) {
    console.warn('⚠️ fetchConnectedToolsSection managed:', e?.message || e);
  }

  if (rows.length === 0 && customConns.length === 0 && oauthActionApps.length === 0 && managedApps.length === 0) {
    connectedToolsSectionCache.set(userId, { text: '', at: Date.now() });
    return '';
  }

  // Collapse multiple connections for the same provider onto one line —
  // a user may have two Notion workspaces, three Gmail accounts, etc.
  // We surface up to three account labels so the model can disambiguate
  // ("from your work Gmail vs. personal Gmail") without flooding the
  // prompt for power users on every tile.
  const byProvider = new Map();
  for (const r of rows) {
    const id = String(r?.provider || '').trim();
    if (!id) continue;
    if (!byProvider.has(id)) byProvider.set(id, []);
    byProvider.get(id).push(r);
  }

  const lines = [];
  for (const [providerId, conns] of byProvider) {
    const desc = CONNECTED_TOOL_DESCRIPTORS[providerId];
    const name = desc?.name
      || providerId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const accounts = conns
      .map((c) => String(c.account_display_name || c.account_handle || c.account_email || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    const accountStr = accounts.length ? ` (${accounts.join(', ')})` : '';
    const allPaused = conns.length > 0 && conns.every((c) => c.status === 'paused');
    const pausedStr = allPaused ? ' [paused]' : '';
    const hint = desc?.hint ? ` — ${desc.hint}` : '';
    lines.push(`- ${name}${accountStr}${pausedStr}${hint}`);
  }

  // Actionable connections — the agent can CALL these via lykn_call_app.
  // Custom (BYO-key) connections plus OAuth-backed action apps (Slack, …),
  // which use the same call contract with an OAuth-minted token.
  const customLines = customConns.slice(0, 25).map((c) => {
    const writes = c.allow_writes ? 'read+write' : 'read-only';
    const desc = c.description ? ` — ${String(c.description).replace(/\s+/g, ' ').slice(0, 160)}` : '';
    return `- ${c.name} [slug: ${c.slug}] (${writes}) ${c.base_url}${desc}`;
  });
  for (const a of oauthActionApps.slice(0, 10)) {
    const writes = a.allow_writes ? 'read+write' : 'read-only';
    const desc = a.description ? ` — ${String(a.description).replace(/\s+/g, ' ').slice(0, 160)}` : '';
    customLines.push(`- ${a.name} [slug: ${a.slug}] (${writes}, OAuth) ${a.base_url}${desc}`);
  }

  const managedBlock = managedApps.length
    ? [
        '',
        '[CONNECTED_APPS — OAuth]',
        'The user connected these apps with OAuth (Settings → Connections). Act in them through lykn_search_connected_tools then lykn_call_connected_tool — never the browser agent. A failed tool call is not a disconnect. Only mention Settings → Connections when a row here says [needs reconnect in Settings] or the app is missing from this list.',
        '',
        ...managedApps.slice(0, 25).map((c) => {
          const needsAttention = c.status !== 'connected' ? ' [needs reconnect in Settings]' : '';
          return `- ${c.name}${needsAttention}`;
        }),
      ].join('\n')
    : '';

  const customBlock = customLines.length
    ? [
        '',
        '[CONNECTED_APPS — actionable]',
        'The user attached these apps with their own API key (Connections → Custom API). First-party Chat cannot call lykn_list_apps / lykn_call_app — that lane is Voice-only. If this turn lists MCP/external tools, those are the callable ones.',
        '',
        ...customLines,
      ].join('\n')
    : '';

  const text = [
    '[CONNECTED_TOOLS]',
    'These are the external apps this user has actively connected to LYKN. Read and act in them live through lykn_search_connected_tools then lykn_call_connected_tool. Their contents are not a Vault library.',
    '',
    ...lines,
    managedBlock,
    customBlock,
  ].join('\n').trim();

  const finalText = text.length > CONNECTED_TOOLS_SECTION_MAX_CHARS
    ? `${text.slice(0, CONNECTED_TOOLS_SECTION_MAX_CHARS)}…`
    : text;

  connectedToolsSectionCache.set(userId, { text: finalText, at: Date.now() });
  return finalText;
}

/**
 * Build the [CURRENT_PROJECT] prompt block for in-LYKN chat. Surfaces
 * the user's active project (header + AI-pushed kv working state +
 * user-selected project knowledge) so the in-LYKN AI sees the
 * same project context that outside AI clients (Claude Desktop, Cursor,
 * Claude Code, ChatGPT) get from `lykn_getContextBlock`.
 *
 * Cached per user for 90 seconds and invalidated on project-write tool calls
 * (PROJECT_WRITE_TOOLS) so
 * the in-LYKN chat reflects outside-client pushes on the very next
 * turn. Returns '' when the user has no active project.
 *
 * Note: we deliberately ship the in-LYKN formatter (not the outside-
 * client one) — the outside variant pushes the model toward MCP tool
 * calls, which the in-LYKN chat loop doesn't currently expose to the
 * underlying model. The body (header + state kv-pairs + clustered
 * project knowledge) is identical; only the trailing footer differs.
 */
/**
 * Load a published custom model for main /app chat and optionally override
 * the frontier model id when the user's plan allows it.
 */
export async function loadCustomModelForChat(userId, customModelId, currentModel, planTier) {
  const empty = {
    customModel: null,
    overlay: { promptSections: [], beliefText: '' },
    model: currentModel,
  };
  if (!supabaseAdmin || !userId || !customModelId) return empty;
  try {
    const { model, overlay } = await resolveCustomModelChatContext(
      supabaseAdmin,
      userId,
      String(customModelId).trim(),
    );
    if (!model) return empty;
    let nextModel = currentModel;
    if (overlay?.modelId) {
      const candidate = normalizeRequestedModel(overlay.modelId);
      const useLoraAdapter = !!overlay.loraActive && isTogetherInferenceModel(candidate);
      if (
        candidate &&
        (useLoraAdapter || isModelAllowedForPlan(candidate, planTier))
      ) {
        nextModel = candidate;
        console.log(
          useLoraAdapter
            ? `🧱 Custom model "${model.name}" → Together serverless LoRA host ${candidate} + adapter ${overlay.loraAdapterId}`
            : `🧱 Custom model "${model.name}" → ${candidate}`,
        );
      } else if (overlay.loraActive && candidate) {
        console.warn(
          `⚠️ LoRA adapter "${candidate}" not applied (plan gate); using ${currentModel} + prompt stack only`,
        );
      }
    }
    return { customModel: model, overlay, model: nextModel };
  } catch (e) {
    console.warn('⚠️ loadCustomModelForChat:', e?.message || e);
    return empty;
  }
}

export async function fetchCustomModelKnowledgeSection(userId, customModel) {
  if (!supabaseAdmin || !userId || !customModel) return '';
  try {
    const section = await loadCustomModelVaultKnowledgeSection(
      supabaseAdmin,
      userId,
      customModel,
    );
    if (section) {
      console.log(
        `📚 Custom model "${customModel.name}" vault knowledge: ${section.length} chars`,
      );
    }
    return section;
  } catch (e) {
    console.warn('⚠️ fetchCustomModelKnowledgeSection:', e?.message || e);
    return '';
  }
}

export function readCustomModelLinkedProjectId(customModel) {
  const meta = customModel?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const raw = meta.linked_project_id ?? meta.linkedProjectId;
  const id = String(raw || '').trim();
  return id.length > 8 ? id : null;
}

export async function fetchProjectSection(authHeader, userId, projectIdOverride = null, opts = {}) {
  const empty = { text: '', projectId: null, neuronIds: [] };
  if (!userId) return empty;
  const slim = !!opts.slim;
  const baseKey = projectIdOverride ? `${userId}:${projectIdOverride}` : userId;
  const cacheKey = slim ? `${baseKey}:slim` : baseKey;
  const cached = projectSectionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PROJECT_SECTION_CACHE_TTL_MS) {
    return {
      text: cached.text || '',
      projectId: cached.projectId || null,
      neuronIds: Array.isArray(cached.neuronIds) ? cached.neuronIds : [],
    };
  }
  const client = createSynthesisUserClient(authHeader) || supabaseAdmin;
  if (!client) return empty;
  try {
    const ctx = projectIdOverride
      ? await loadProjectContextById(client, userId, projectIdOverride)
      : await loadActiveProjectContext(client, userId);
    const neuronIds = Array.isArray(ctx?.neurons)
      ? ctx.neurons.map((n) => String(n?.node_id || '').trim()).filter(Boolean)
      : [];
    let text = ctx ? formatProjectStateForPromptInLykn(ctx, { slim }) : '';
    // Other projects help the model connect the screen / topic to the right
    // focus when the user has more than one active project. Skip on slim
    // (casual) turns — listing every project is what used to pull the model
    // into setActiveProject on "how are you?".
    if (!slim) {
      try {
        const others = await loadOtherProjectsForUser(client, userId, {
          excludeId: ctx?.project?.id || null,
          limit: 8,
        });
        const catalog = formatOtherProjectsForPromptOutsideClient(others);
        if (catalog) {
          text = text ? `${text}\n\n${catalog}` : catalog;
        }
      } catch {
        /* catalog is best-effort */
      }
    }
    const entry = {
      text,
      projectId: ctx?.project?.id || null,
      neuronIds,
      at: Date.now(),
    };
    projectSectionCache.set(cacheKey, entry);
    return {
      text: entry.text || '',
      projectId: entry.projectId,
      neuronIds: entry.neuronIds,
    };
  } catch (e) {
    console.warn('⚠️ fetchProjectSection:', e?.message || e);
    return empty;
  }
}

