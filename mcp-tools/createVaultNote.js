// ============================================================================
// mcp-tools/createVaultNote.js — save a note into the user's vault from chat
// ============================================================================
// Write. The vault is the user's long-term memory of saved notes, articles,
// snippets, files. Today an outside AI client (Claude / Cursor) that has
// generated something worth keeping has no first-class way to drop it
// into the vault — it can only tell the user "you should save this". This
// tool closes that gap: when the model decides a piece of content is
// vault-worthy, it can mint a notes row directly.
//
// Why a NEW tool, not a generic "createNeuron":
//   Beliefs, facts, and vault notes have different lifecycles. Beliefs
//   need a `belief_key` + `serves_need` + ratification flow. Facts need
//   a `fact_kind` + auto-cluster eligibility check. Vault notes are the
//   simplest of the three — title + content + tags + done. Collapsing
//   them into one tool would hide that the model has to think
//   differently about each, which leads to mis-typed neurons.
//
// Why "vault note" specifically (not "scratch buffer" or "memo"):
//   The user already has mental models for what their vault holds. Using
//   the same vocabulary makes the resulting note discoverable via the
//   same /vault search + the same lykn_searchVault / lykn_findConnections
//   surfaces. A separate "chat memo" store would silently fragment the
//   memory layer.
//
// Source stamping:
//   Every note carries a `source` column. We stamp 'lykn-chat-agent' so
//   the user can filter / audit AI-created notes separately from manual
//   ones. The activity feed already groups notes by source.

import { jsonContent, errorContent, requireWrite } from './index.js';

const TITLE_MAX = 200;
const CONTENT_MAX = 60000;           // Generous; vault notes can hold articles.
                                      // 60KB is the soft cap before we start
                                      // worrying about bloated rows; the
                                      // 120KB hard cap from migration 008
                                      // (oversized-content cleanup) still applies.
const FOLDER_MAX = 80;
const TAG_MAX_LEN = 32;
const TAG_MAX_COUNT = 12;

export const createVaultNoteTool = {
  name: 'lykn_createVaultNote',
  title: 'Save a note to the user\'s LYKN vault',
  scope: 'write',
  description: [
    'Save a note into the user\'s LYKN vault — their long-term memory of',
    'saved articles, snippets, notes, files. Use this when YOU\'ve just',
    'generated (or the user has just shared) something worth keeping past',
    'the end of this chat:',
    '  • A clean summary of a complex topic you walked them through',
    '  • A working code snippet / config they\'ll want to re-find later',
    '  • A piece of research / quote the user reacted positively to',
    '  • A first draft of writing they wanted captured',
    '',
    'After saving, the note shows up in their /vault, is searchable via',
    'lykn_searchVault / lykn_findConnections, and counts as a `vault_<id>`',
    'neuron in lykn_addProjectNeurons — so a common pattern is:',
    '  createVaultNote(...) → findConnections({ node_id: vault_<id> }) →',
    '  addProjectNeurons.',
    '',
    'BEFORE calling, ASK the user once: "Want me to drop this into your',
    'vault?" — the user\'s vault is their personal space and silently',
    'writing to it is hostile. The ask gates the call; the user\'s yes is',
    'the consent. Don\'t call without explicit approval.',
    '',
    'When NOT to call:',
    '  • Casual / one-off chat replies. Vault content should be re-useful.',
    '  • Anything the user asked you to KEEP PRIVATE / OFF THE RECORD.',
    '  • Personal principles → user adds these as Core Belief neurons in',
    '    Synthesis Layer (+ → Core Belief neuron). Do not propose beliefs.',
    '  • Atomic identity disclosures → use lykn_proposeFact (observation,',
    '    not memory).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short human-readable title (<=200 chars). Optional but strongly preferred — vault search ranks title hits higher than content hits.',
      },
      content: {
        type: 'string',
        description: 'The note body (<=60,000 chars). Plain text or lightly-formatted markdown. Do NOT embed base64 file blobs here — vault file attachments go through the upload flow, not this tool.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of tags. Each tag <=32 chars, max 12 tags. Use existing user tags when you know them; invent new ones sparingly.',
      },
      folder: {
        type: 'string',
        description: 'Optional folder / collection name (<=80 chars). Defaults to no folder.',
      },
    },
    required: ['content'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const content = String(args?.content || '').trim();
    if (!content) return errorContent('content is required and must be non-empty.');
    if (content.length > CONTENT_MAX) {
      return errorContent(`content exceeds ${CONTENT_MAX} chars. Trim before saving — vault notes are not the right place for very long blobs.`);
    }
    // Reject obvious base64 data-URL bombs. Migration 008 cleans these
    // up after the fact; rejecting at write time saves the row entirely.
    if (/data:[a-z/+.-]+;base64,/i.test(content) && content.length > 8000) {
      return errorContent('content looks like an inlined base64 file blob. Use the vault upload flow for binary attachments.');
    }

    const titleRaw = typeof args?.title === 'string' ? args.title.trim().slice(0, TITLE_MAX) : '';
    const title = titleRaw || null;

    const folderRaw = typeof args?.folder === 'string' ? args.folder.trim().slice(0, FOLDER_MAX) : '';
    const folder = folderRaw || null;

    const tagsRaw = Array.isArray(args?.tags) ? args.tags : [];
    const tags = [];
    const tagSeen = new Set();
    for (const raw of tagsRaw) {
      if (tags.length >= TAG_MAX_COUNT) break;
      if (typeof raw !== 'string') continue;
      const t = raw.trim().slice(0, TAG_MAX_LEN);
      if (!t) continue;
      const key = t.toLowerCase();
      if (tagSeen.has(key)) continue;
      tagSeen.add(key);
      tags.push(t);
    }

    const source = `lykn-chat-agent:${ctx.attribSurface || 'lykn-chat'}`.slice(0, 64);

    const row = {
      user_id: ctx.userId,
      title,
      content,
      tags: tags.length > 0 ? tags : null,
      folder,
      source,
    };

    const { data, error } = await ctx.supabaseAdmin
      .from('notes')
      .insert(row)
      .select('id, title, content, tags, folder, created_at, updated_at')
      .single();
    if (error) {
      console.warn('[mcp:createVaultNote]', error.message);
      return errorContent(`vault note insert failed: ${error.message}`);
    }

    return jsonContent({
      ok: true,
      message: title
        ? `Saved "${title}" to your vault.`
        : 'Saved to your vault.',
      note: {
        id: data.id,
        title: data.title,
        node_id: `vault_${data.id}`,
        tags: data.tags || [],
        folder: data.folder,
        created_at: data.created_at,
        url: `/vault?note=${encodeURIComponent(data.id)}`,
      },
    });
  },
};
