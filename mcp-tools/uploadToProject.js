// ============================================================================
// mcp-tools/uploadToProject.js — save a dragged-in chat file to the vault AND
// cluster it into a project, in one verb.
// ============================================================================
// This is the "upload this to my X project" tool. When the user drags/pastes
// a file (image, pdf, …) into the chat and asks the assistant to put it in a
// project, the model has no way to do that today: the file lives only as an
// ephemeral turn attachment, and the two existing tools — lykn_saveFileToVault
// (persist a file as a vault note) and lykn_addProjectNeurons (cluster a
// vault_<id> into a project) — would have to be chained, but the model has no
// handle on the dragged file's bytes.
//
// The in-app chat passes this turn's binary attachments to the tool layer as
// ctx.turnAttachments (compact metadata) + ctx.turnImageUrls (the base64 image
// data already sent for vision). This tool reads those, persists the chosen
// attachment as a durable vault note (reusing the same renderable-attachment
// pipeline as lykn_saveFileToVault), then upserts vault_<id> into the resolved
// project's neuron membership.
//
// In-app ONLY: it is intentionally NOT in mcp-tools/index.js, because external
// MCP clients (Claude Desktop, Cursor, …) never have a dragged-in chat
// attachment to act on.

import { jsonContent, errorContent } from './index.js';
import { resolveVaultAttachment } from '../lib/vaultAttachment.js';
import { resolveProjectByNameOrId } from '../lib/projectWriteTarget.js';
import { buildAttachmentColumns } from '../lib/vault/attachmentType.js';

const TITLE_MAX = 200;
const TAG_MAX_LEN = 32;
const TAG_MAX_COUNT = 12;
const FOLDER_MAX = 80;
const CONTENT_MAX = 60000;

function cleanTags(raw) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(raw) ? raw : []) {
    if (out.length >= TAG_MAX_COUNT) break;
    if (typeof t !== 'string') continue;
    const tag = t.trim().slice(0, TAG_MAX_LEN);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

// Pick the attachment the user means. Default to the only/most-recent one;
// honour an explicit `attachment` selector (1-based index, or a name match).
function pickAttachment(attachments, selector) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  const sel = String(selector || '').trim();
  if (!sel) return attachments[attachments.length - 1];

  const asIndex = Number(sel);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= attachments.length) {
    return attachments[asIndex - 1];
  }
  const lc = sel.toLowerCase();
  const exact = attachments.find((a) => String(a.name || '').toLowerCase() === lc);
  if (exact) return exact;
  const partial = attachments.find((a) => String(a.name || '').toLowerCase().includes(lc));
  if (partial) return partial;
  // Type word ("the image", "the pdf") → first attachment of that type.
  const byType = attachments.find((a) => lc.includes(String(a.type || '')));
  return byType || attachments[attachments.length - 1];
}

export const uploadToProjectTool = {
  name: 'lykn_uploadToProject',
  title: 'Save a dragged-in file to the vault and add it to a project',
  scope: 'write',
  description: [
    'Save a file the user just dragged / pasted into THIS chat (an image, PDF,',
    'document, etc.) into their LYKN vault AND cluster it into a project — in',
    'one step. This is the tool for "upload this to my <project>", "add this',
    'image to the <project> project", "put this in <project>".',
    '',
    'It operates on the attachments ON THE CURRENT TURN. If there is exactly',
    'one attachment, it uses that; otherwise pass `attachment` to pick by name',
    "(e.g. \"logo.png\") or 1-based index. You do NOT need a URL or node_id —",
    'the file bytes are already available to this tool.',
    '',
    'Project: pass `project_name` (what the user called it — "my brand',
    'project") or `project_id`. Omit both to use the active/scoped project.',
    'Projects are user-created; if the name does not match one, the tool says',
    'so rather than creating a new project.',
    '',
    'After it runs, the file is a real, viewable vault item (it renders in',
    '/vault and is searchable via lykn_searchVault) and appears in the',
    "project's neuron cluster. Idempotent on the project side.",
    '',
    'CONSENT: only call when the user clearly asks to upload / save / add the',
    'attachment to a project. Do not save dragged files to the vault silently.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      attachment: {
        type: 'string',
        description: 'Which attachment to upload when several are present — its filename (e.g. "chart.png") or 1-based index. Omit when there is only one.',
      },
      project_name: {
        type: 'string',
        description: "The project to add it to, as the user named it. Resolved against the user's projects. Omit with project_id to use the active project.",
      },
      project_id: {
        type: 'string',
        description: 'Optional explicit project UUID. Takes priority over project_name.',
      },
      title: {
        type: 'string',
        description: 'Optional vault item title (<=200 chars). Defaults to the file name.',
      },
      note: {
        type: 'string',
        description: 'Optional short description/context saved as the vault item body.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags (each <=32 chars, max 12).',
      },
      folder: {
        type: 'string',
        description: 'Optional folder / collection name (<=80 chars).',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const attachments = Array.isArray(ctx.turnAttachments) ? ctx.turnAttachments : [];
    if (!attachments.length) {
      return jsonContent({
        ok: false,
        reason: 'no_attachment',
        message:
          'There is no file attached to this message to upload. Ask the user to drag or paste the file into the chat first.',
      });
    }

    const chosen = pickAttachment(attachments, args?.attachment);
    if (!chosen) {
      return jsonContent({
        ok: false,
        reason: 'attachment_not_matched',
        message: `Couldn't tell which attachment to upload. Available: ${attachments.map((a) => a.name || a.type).join(', ')}.`,
      });
    }

    // Recover the image bytes from the vision payload when the dragged image
    // has no durable storagePath yet (its background upload may still be in
    // flight). turnImageUrls is ordered to match each image's imageIndex.
    const imageUrls = Array.isArray(ctx.turnImageUrls) ? ctx.turnImageUrls : [];
    const dataUrl =
      Number.isInteger(chosen.imageIndex) && chosen.imageIndex < imageUrls.length
        ? imageUrls[chosen.imageIndex]
        : undefined;

    const title = typeof args?.title === 'string' && args.title.trim()
      ? args.title.trim().slice(0, TITLE_MAX)
      : (chosen.name || 'Uploaded file').slice(0, TITLE_MAX);

    const attachment = await resolveVaultAttachment(ctx, {
      fileUrl: typeof chosen.url === 'string' ? chosen.url : '',
      dataUrl: typeof dataUrl === 'string' ? dataUrl : undefined,
      storagePath: chosen.storagePath || '',
      storageBucket: chosen.storageBucket || '',
      filename: chosen.name || '',
      mimeType: chosen.mime || '',
      title,
    });

    if (!attachment) {
      return jsonContent({
        ok: false,
        reason: 'file_unavailable',
        message:
          "Couldn't access that file's contents to save it. It may still be uploading — ask the user to try again in a moment.",
      });
    }

    // Resolve the destination project BEFORE writing the note, so we don't
    // create an orphan vault item when the project name doesn't resolve.
    const projectName = typeof args?.project_name === 'string' ? args.project_name.trim() : '';
    const projectId = typeof args?.project_id === 'string' ? args.project_id.trim() : '';
    const { project, reason } = await resolveProjectByNameOrId(ctx, { projectId, projectName });
    if (!project) {
      if (reason === 'project_name_not_found') {
        return jsonContent({
          ok: false,
          reason: 'project_not_found',
          message: `I couldn't find a project called "${projectName}". Ask the user which project, or to create it first.`,
        });
      }
      if (reason === 'project_not_found_or_not_writable') {
        return jsonContent({
          ok: false,
          reason: 'project_not_writable',
          message: 'That project is not writable. Only user-created synthesis projects accept AI clustering.',
        });
      }
      return jsonContent({
        ok: false,
        reason: 'no_active_project',
        message:
          'No target project resolved. Pass project_name (or project_id) for a user-created project, or ask the user to set an active project.',
      });
    }

    // Build the vault note body: optional description + the renderable
    // attachment marker the vault dispatches on to show a real card.
    const body = typeof args?.note === 'string' ? args.note.trim().slice(0, CONTENT_MAX - 2000) : '';
    let content = body || title;
    const marker = `\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;
    if (content.length + marker.length > CONTENT_MAX) {
      content = content.slice(0, CONTENT_MAX - marker.length).trimEnd();
    }
    content += marker;

    const tags = cleanTags(args?.tags);
    const folder = typeof args?.folder === 'string' ? args.folder.trim().slice(0, FOLDER_MAX) || null : null;
    const source = `lykn-chat-agent:${ctx.attribSurface || 'lykn-chat'}`.slice(0, 64);

    const generatedFile = {
      file_url: attachment.url || null,
      storage_path: attachment.storagePath || null,
      storage_bucket: attachment.storageBucket || null,
      filename: attachment.name || null,
      mime_type: attachment.mimeType || null,
      attachment_type: attachment.type || null,
      saved_at: new Date().toISOString(),
    };

    const selectCols = 'id, title, content, tags, folder, created_at';
    let { data: note, error: noteErr } = await ctx.supabaseAdmin
      .from('vault_items')
      .insert({
        user_id: ctx.userId,
        title,
        content,
        tags: tags.length ? tags : null,
        folder,
        source,
        ...buildAttachmentColumns(attachment),
        ai_signals: { generated_file: generatedFile },
      })
      .select(selectCols)
      .single();

    // ai_signals ships in a later migration; retry without it on older DBs so
    // the upload still lands (mirrors lykn_saveFileToVault's fallback).
    const missingColumn =
      noteErr &&
      (noteErr.code === 'PGRST204' ||
        /could not find/i.test(noteErr.message || '') ||
        /does not exist/i.test(noteErr.message || ''));
    if (missingColumn) {
      ({ data: note, error: noteErr } = await ctx.supabaseAdmin
        .from('vault_items')
        .insert({ user_id: ctx.userId, title, content, tags: tags.length ? tags : null, folder, source })
        .select(selectCols)
        .single());
    }

    if (noteErr || !note?.id) {
      return errorContent(`vault save failed: ${noteErr?.message || 'unknown error'}`);
    }

    // Cluster the new vault item into the resolved project. Idempotent upsert.
    const nodeId = `vault_${note.id}`;
    const { error: clusterErr } = await ctx.supabaseAdmin
      .from('lykn_project_neurons')
      .upsert(
        {
          user_id: ctx.userId,
          project_id: project.id,
          node_id: nodeId,
          node_label: (title || note.title || 'Uploaded file').slice(0, 240),
          node_kind: 'vault',
        },
        { onConflict: 'user_id,project_id,node_id' },
      );

    if (clusterErr) {
      // The file IS in the vault; only the project link failed. Report partial
      // success so the model can tell the user and offer to retry the cluster.
      return jsonContent({
        ok: false,
        reason: 'clustering_failed',
        note: { id: note.id, node_id: nodeId, url: `/vault?note=${encodeURIComponent(note.id)}` },
        project: { id: project.id, name: project.name },
        message: `Saved "${title}" to the vault, but couldn't add it to "${project.name}" (${clusterErr.message}). The file is safe in the vault.`,
      });
    }

    // Bump project recency so it surfaces at the top of the synthesis dropdown.
    await ctx.supabaseAdmin
      .from('lykn_projects')
      .update({ last_active_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', project.id)
      .eq('user_id', ctx.userId)
      .then(() => {}, () => {});

    return jsonContent({
      ok: true,
      note: {
        id: note.id,
        title: note.title,
        node_id: nodeId,
        url: `/vault?note=${encodeURIComponent(note.id)}`,
        attachment_type: attachment.type,
      },
      project: { id: project.id, name: project.name },
      message: `Uploaded "${title}" to your vault and added it to "${project.name}".`,
    });
  },
};
