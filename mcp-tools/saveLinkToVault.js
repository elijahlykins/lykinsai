// ============================================================================
// mcp-tools/saveLinkToVault.js — save a pasted/dropped URL into the user's vault
// ============================================================================
// Write. Companion to lykn_createVaultNote — but specialised for URLs.
//
// WHY A SEPARATE TOOL
//
// `lykn_createVaultNote` produces a plain text note. When the AI saves a URL
// through it, the vault gets a row like `title: "https://example.com",
// content: "https://example.com"` — searchable by URL substring, but with no
// favicon, no thumbnail, no rich card, and no platform-specific embed.
//
// The client-side flow at src/lib/saveToVault.ts (`saveLinkToVault`) builds
// a much richer row: YouTube branch fetches oEmbed for canonical title +
// thumbnail, social branches fetch oEmbed for embed HTML, generic URLs
// produce a bookmark card with an OG image. The vault page renders any
// note with `[ATTACHMENTS_JSON:...]` as a rich card.
//
// This tool mirrors that shape from the server. The AI hands us a URL +
// the title/summary it already derived from [SCRAPED_WEB_PAGES] (which
// the chat handler scraped on the same turn), and we build the rich
// attachment payload so the AI-saved note looks identical to a manual
// drop in the vault UI.
//
// PULL MODEL PRESERVED
//
// This tool only WRITES to LYKN. The AI is still not dispatching to
// outside tools or fetching anything new — the URL content was already
// pulled into context by the chat handler's auto-scrape pipeline.
//
// DEDUPE
//
// URL match against existing notes.content is the same heuristic
// saveLinkToVault.ts uses client-side. Same URL → same note (returns
// the existing row instead of creating a duplicate).

import { jsonContent, errorContent, requireWrite } from './index.js';
import { buildAttachmentColumns } from '../lib/vault/attachmentType.js';

const URL_MAX = 2048;
const TITLE_MAX = 200;
const SUMMARY_MAX = 4000;
const TAG_MAX_LEN = 32;
const TAG_MAX_COUNT = 12;

// Mirrors src/canvas/utils/socialEmbed.ts patterns. Kept inline so the
// server doesn't import a frontend module. Order matters: more specific
// patterns first (e.g. YouTube before generic).
function detectPlatform(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return null;
  if (/^https?:\/\/((www\.|m\.|music\.)?youtube\.com\/(watch|shorts|playlist|live)|youtu\.be\/)/i.test(url)) return 'youtube';
  if (/^https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/i.test(url)) return 'x';
  if (/^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\//i.test(url)) return 'instagram';
  if (/^https?:\/\/((www\.|m\.)?tiktok\.com\/@[^/]+\/(video|photo)\/|vm\.tiktok\.com\/|(www\.)?tiktok\.com\/t\/)/i.test(url)) return 'tiktok';
  if (/^https?:\/\/((www\.|m\.|web\.)?facebook\.com\/.+\/(posts|videos|reel|watch)|fb\.watch\/)/i.test(url)) return 'facebook';
  if (/^https?:\/\/(www\.)?linkedin\.com\/(posts|pulse|feed|in)\//i.test(url)) return 'linkedin';
  if (/^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(url)) return 'reddit';
  if (/^https?:\/\/(bsky\.app|staging\.bsky\.app)\/profile\//i.test(url)) return 'bluesky';
  return null;
}

const PLATFORM_LABEL = Object.freeze({
  youtube: 'YouTube',
  x: 'X (Twitter)',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  bluesky: 'Bluesky',
});

const PLATFORM_FAVICON = Object.freeze({
  youtube: 'https://www.youtube.com/favicon.ico',
  x: 'https://abs.twimg.com/favicons/twitter.3.ico',
  instagram: 'https://www.instagram.com/favicon.ico',
  tiktok: 'https://www.tiktok.com/favicon.ico',
  facebook: 'https://www.facebook.com/favicon.ico',
  linkedin: 'https://www.linkedin.com/favicon.ico',
  reddit: 'https://www.reddit.com/favicon.ico',
  bluesky: 'https://bsky.app/static/favicon-32x32.png',
});

function safeHostname(rawUrl) {
  try { return new URL(String(rawUrl)).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

// PostgREST ILIKE pattern escape — same as saveToVault.ts. Without this,
// URLs containing `_` (very common — query strings, paths) wildcard-match
// unrelated rows in the dedupe lookup.
function buildLikePattern(searchTerm) {
  const escaped = String(searchTerm).replace(/[\\%_]/g, '\\$&');
  return `%${escaped}%`;
}

export const saveLinkToVaultTool = {
  name: 'lykn_saveLinkToVault',
  title: "Save a URL the user shared into the user's LYKN vault as a rich link note",
  scope: 'write',
  description: [
    "Save a URL the user pasted, dropped, or shared in chat into the user's",
    'vault as a rich link note (with favicon, title, summary). Use this',
    'INSTEAD of lykn_createVaultNote whenever the thing the user wants',
    'saved is fundamentally a LINK, not a chunk of text.',
    '',
    'WHEN TO CALL — be more agentic than the createVaultNote rule:',
    '  • The user pasted a URL and said something like "save this", "drop',
    '    this in my vault", "keep this", "for later", "add this to my',
    '    reading list" → call this tool, silently, then confirm in one',
    '    line ("Saved <Title> to your vault.").',
    '  • The user pasted a URL with no explicit save ask but is clearly',
    "    collecting references (e.g. they've pasted 2+ URLs this session,",
    '    they\'re building a reading list, they said "look at this" /',
    '    "this is interesting" / "found this") → call this tool silently',
    '    with a one-line confirmation. The vault is cheap; saving the',
    '    reference is the obvious next move.',
    '  • The user explicitly asks LYKN to look at a URL to evaluate it,',
    "    and the evaluation comes out positive → offer to save once",
    '    ("Want me to drop this in your vault?") and call on confirmation.',
    '',
    'WHEN NOT TO CALL:',
    '  • The user is asking you to PROCESS the URL\'s content (translate,',
    '    summarise, critique) but did not ask to save the reference → do',
    "    the processing, don't auto-save.",
    '  • The URL is to something already in the vault (you\'ll see the',
    '    duplicate result come back as ok:true, action:"duplicate" — that\'s',
    '    fine; surface it as "you already have that saved" rather than',
    '    a fake confirmation).',
    '  • The user asked to keep something PRIVATE / OFF THE RECORD.',
    '',
    'INPUTS:',
    '  • url (required) — the URL to save. Must be http(s).',
    '  • title (optional) — short human-readable title (<=200 chars). Strongly',
    '    preferred — derive it from [SCRAPED_WEB_PAGES] content if the chat',
    "    handler already scraped the page this turn. Falls back to the URL's",
    "    hostname if not provided.",
    '  • summary (optional) — 1-3 sentence description (<=4000 chars).',
    '    Pulled from [SCRAPED_WEB_PAGES] content where possible. Skipped',
    '    if not provided; downstream describe-vault-item background job',
    '    will fill one in later.',
    '  • tags (optional) — up to 12 tags, each <=32 chars. The tags',
    '    `link` + `uploaded` (or the platform-specific equivalents like',
    '    `youtube`, `social`) are added automatically; do NOT pass them.',
    '',
    'OUTPUT — { ok, note: { id, node_id, title, url, ... }, action }.',
    '  action is "created" on a fresh save, "duplicate" if the URL was',
    '  already saved (the existing note is returned). Surface either',
    "  outcome with a one-line confirmation, not a longer explanation.",
    '',
    'For NON-URL content the user wants saved (a snippet, a code block,',
    'a draft you produced), use lykn_createVaultNote instead. That tool',
    'still expects you to ask first.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full http(s) URL to save. Must include the scheme.',
        maxLength: URL_MAX,
      },
      title: {
        type: 'string',
        description: 'Short title for the link (<=200 chars). Derive from scraped content when available.',
        maxLength: TITLE_MAX,
      },
      summary: {
        type: 'string',
        description: '1-3 sentence summary of what the page is about (<=4000 chars). Helps the vault search later.',
        maxLength: SUMMARY_MAX,
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional extra tags. `link` / `uploaded` / platform tag added automatically.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const rawUrl = String(args?.url || '').trim();
    if (!rawUrl) return errorContent('url is required.');
    if (rawUrl.length > URL_MAX) {
      return errorContent(`url exceeds ${URL_MAX} chars.`);
    }
    if (!/^https?:\/\//i.test(rawUrl)) {
      return errorContent('url must start with http:// or https://.');
    }

    let parsed;
    try { parsed = new URL(rawUrl); }
    catch { return errorContent('url is not a valid URL.'); }
    const url = parsed.toString();

    // Generated artifacts (a QuickChart image, a Supabase signed download URL)
    // are NOT links to bookmark — saving them here strands a dead "quickchart.io"
    // card with a broken image. Route them to lykn_saveFileToVault, which pulls
    // the bytes into the vault and saves a real, viewable card.
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const isGeneratedArtifact =
      host === 'quickchart.io' ||
      /\/storage\/v1\/object\/(sign|public)\//.test(parsed.pathname);
    if (isGeneratedArtifact) {
      return errorContent(
        'This URL is a generated artifact (chart/image/file), not a link to bookmark. ' +
        'Use lykn_saveFileToVault and pass this URL as file_url so it is saved as a viewable vault card.',
      );
    }

    const platform = detectPlatform(url);
    const platformLabel = platform ? PLATFORM_LABEL[platform] || platform : '';
    const hostname = safeHostname(url);

    const titleRaw = typeof args?.title === 'string' ? args.title.trim().slice(0, TITLE_MAX) : '';
    const title = titleRaw
      || (platform ? `${platformLabel} link` : hostname || url);

    const summary = typeof args?.summary === 'string'
      ? args.summary.trim().slice(0, SUMMARY_MAX)
      : '';

    const userTagsRaw = Array.isArray(args?.tags) ? args.tags : [];
    const userTags = [];
    const tagSeen = new Set();
    for (const raw of userTagsRaw) {
      if (userTags.length >= TAG_MAX_COUNT) break;
      if (typeof raw !== 'string') continue;
      const t = raw.trim().slice(0, TAG_MAX_LEN);
      if (!t) continue;
      const key = t.toLowerCase();
      if (tagSeen.has(key)) continue;
      tagSeen.add(key);
      userTags.push(t);
    }
    const autoTags = platform
      ? (platform === 'youtube' ? ['youtube', 'uploaded'] : [platform, 'social', 'uploaded'])
      : ['link', 'uploaded'];
    const tags = [];
    const tagDedupe = new Set();
    for (const t of [...autoTags, ...userTags]) {
      const key = t.toLowerCase();
      if (tagDedupe.has(key)) continue;
      if (tags.length >= TAG_MAX_COUNT) break;
      tagDedupe.add(key);
      tags.push(t);
    }

    const sb = ctx.supabaseAdmin;

    // URL dedupe — substring match against content. Mirrors the
    // saveToVault.ts dedupe so the manual-drop path and the AI-save path
    // can't end up with two copies of the same URL. Cheap (indexed ilike).
    try {
      const { data: existing, error: dupErr } = await sb
        .from('vault_items')
        .select('id, title, content, tags, folder, source, created_at, updated_at')
        .eq('user_id', ctx.userId)
        .ilike('content', buildLikePattern(url))
        .limit(1);
      if (dupErr) {
        console.warn('[mcp:saveLinkToVault] dedupe lookup failed:', dupErr.message);
      } else if (existing && existing.length > 0) {
        const e = existing[0];
        return jsonContent({
          ok: true,
          action: 'duplicate',
          message: `That link is already in your vault as "${e.title || url}".`,
          note: {
            id: e.id,
            node_id: `vault_${e.id}`,
            title: e.title,
            url,
            tags: e.tags || [],
            folder: e.folder || null,
            created_at: e.created_at,
            ui_url: `/vault?note=${encodeURIComponent(e.id)}`,
          },
        });
      }
    } catch (e) {
      console.warn('[mcp:saveLinkToVault] dedupe threw:', e?.message || e);
    }

    // Build the attachment payload. Shape mirrors src/lib/saveToVault.ts —
    // the vault page renders any note containing [ATTACHMENTS_JSON:...] as
    // a rich card (favicon + title + image + embed). We can't fetch the
    // OG image / oEmbed HTML here without refactoring /api/unfurl out of
    // the route layer; instead we surface what we KNOW (URL, title,
    // summary, platform favicon, hostname-as-siteName) and let the
    // background describe-vault-item job upgrade the row later.
    const attachmentType = platform === 'youtube'
      ? 'youtube'
      : platform
        ? platform
        : 'bookmark';

    const attachment = {
      type: attachmentType,
      url,
      name: title,
      title,
      description: summary,
      image: '',
      favicon: PLATFORM_FAVICON[platform] || '',
      siteName: platformLabel || hostname,
      articleText: summary,
      oembedHtml: '',
      oembedType: platform || '',
      authorName: '',
      authorHandle: '',
      thumbnail_url: '',
    };

    // Body shape mirrors the social-platform branch of saveToVault.ts so
    // searchVault substring matches against `[title]\n[summary]\nLink
    // saved: <url>` work the same way for AI-saved and manually-saved
    // links. Also keeps the URL inside the searchable content column,
    // which the dedupe check above depends on.
    const bodyLines = [title];
    if (summary) bodyLines.push(summary);
    bodyLines.push(`Link saved: ${url}`);
    const contentBody = bodyLines.join('\n');
    const noteContent = `${contentBody}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

    const source = platform === 'youtube'
      ? 'lykn-chat-agent:youtube_drop'
      : platform
        ? `lykn-chat-agent:${platform}_drop`
        : 'lykn-chat-agent:link_drop';

    const row = {
      user_id: ctx.userId,
      title: title.slice(0, TITLE_MAX),
      content: noteContent,
      tags: tags.length ? tags : null,
      source: source.slice(0, 64),
      ...buildAttachmentColumns(attachment),
    };

    const selectCols = 'id, title, content, tags, folder, source, created_at, updated_at';
    let { data, error } = await sb
      .from('vault_items')
      .insert(row)
      .select(selectCols)
      .single();

    // Normalized attachment columns ship in migration 104; retry without them
    // on older DBs so the link still lands.
    const missingColumn =
      error &&
      (error.code === 'PGRST204' ||
        /could not find/i.test(error.message || '') ||
        /does not exist/i.test(error.message || ''));
    if (missingColumn) {
      ({ data, error } = await sb
        .from('vault_items')
        .insert({
          user_id: ctx.userId,
          title: title.slice(0, TITLE_MAX),
          content: noteContent,
          tags: tags.length ? tags : null,
          source: source.slice(0, 64),
        })
        .select(selectCols)
        .single());
    }
    if (error) {
      console.warn('[mcp:saveLinkToVault]', error.message);
      return errorContent(`vault link insert failed: ${error.message}`);
    }

    return jsonContent({
      ok: true,
      action: 'created',
      message: `Saved "${data.title || url}" to your vault.`,
      note: {
        id: data.id,
        node_id: `vault_${data.id}`,
        title: data.title,
        url,
        tags: data.tags || [],
        folder: data.folder || null,
        source: data.source,
        created_at: data.created_at,
        ui_url: `/vault?note=${encodeURIComponent(data.id)}`,
        platform: platform || null,
      },
    });
  },
};
