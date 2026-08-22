/**
 * Translation between the Supabase row shapes and the local store's.
 *
 * Pure functions only — no network, no database. Everything that decides what
 * a migrated row *means* lives here so it can be tested against fixtures
 * without standing up either end. importer.cjs does the moving; this decides
 * the shape.
 *
 * The column names diverged for good reasons and the mapping is not always
 * one-to-one:
 *   - `storage_path` names an object in a bucket; the local `blob_path` names
 *     a file on disk. They are never the same string, so the mapper reports
 *     which blobs to fetch and the importer fills the paths in afterwards.
 *   - `tags` is a Postgres text[] and arrives as a real array; locally it is
 *     JSON in a TEXT column.
 *   - A chat is two cloud rows (metadata + one JSON blob) and becomes a thread
 *     plus N message rows here.
 */

const sourceText = require("./sourceText.cjs");

const ORIGIN = "supabase";

/** Bucket sentinel written onto migrated rows so the UI stops signing them. */
const LOCAL_BUCKET = "local";

/** The normalized columns that name an object, and where each lands locally. */
const COLUMN_BLOBS = [
  { field: "storage_path", variant: "original", localField: "blob_path" },
  { field: "variant_medium_path", variant: "medium", localField: "variant_med" },
  { field: "variant_thumb_path", variant: "thumb", localField: "variant_thumb" },
];

/** The same three ideas, as they appear inside the `[ATTACHMENTS_JSON:…]` marker. */
const ATTACHMENT_BLOBS = [
  { field: "storagePath", suffix: "" },
  { field: "variantMediumPath", suffix: "-medium" },
  { field: "variantThumbPath", suffix: "-thumb" },
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Postgres array literal form: {a,b,c}
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        return trimmed
          .slice(1, -1)
          .split(",")
          .map((s) => s.replace(/^"|"$/g, "").trim())
          .filter(Boolean);
      }
      return [];
    }
  }
  return [];
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every object this row references, from both places it can reference one.
 *
 * The normalized columns describe only the *primary* attachment. A note with
 * five images keeps the other four in the `[ATTACHMENTS_JSON:…]` marker inside
 * `content`, so a migration that only read the columns would leave those files
 * behind while the row still claimed them — the vault would look complete and
 * render four broken tiles.
 *
 * Specs are deduplicated by cloud path, because the primary attachment is
 * normally listed in both places and downloading it twice would double the
 * disk cost of every image in the vault. Each spec therefore carries a list of
 * targets to write the resulting local path back to.
 *
 * @returns {{key: string, bucket: string, path: string, variant: string,
 *            targets: ({type: "column", field: string}
 *                     |{type: "attachment", index: number, field: string})[]}[]}
 */
function collectBlobSpecs(row = {}) {
  const bucket = String(row.storage_bucket || "user-files");
  const byKey = new Map();

  const add = (cloudPath, variant, target) => {
    if (!cloudPath) return;
    const path = String(cloudPath);
    const key = `${bucket}/${path}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.targets.push(target);
      return;
    }
    byKey.set(key, { key, bucket, path, variant, targets: [target] });
  };

  for (const spec of COLUMN_BLOBS) {
    add(row[spec.field], spec.variant, { type: "column", field: spec.localField });
  }

  const attachments = sourceText.parseAttachments(row.content);
  attachments.forEach((attachment, index) => {
    for (const spec of ATTACHMENT_BLOBS) {
      // The first attachment shares its filenames with the columns above, so
      // it keeps the plain variant names and dedupes against them.
      const base = index === 0 ? "" : `att${index}`;
      const variant =
        index === 0
          ? { "": "original", "-medium": "medium", "-thumb": "thumb" }[spec.suffix]
          : `${base}${spec.suffix || "-original"}`;
      add(attachment?.[spec.field], variant, {
        type: "attachment",
        index,
        field: spec.field,
      });
    }
  });

  return [...byKey.values()];
}

/**
 * Point a row's `content` marker at files on this device.
 *
 * Also clears `url`: those are signed cloud URLs with an expiry, and leaving
 * one in place means the UI prefers a link that will 403 within the hour over
 * the local file sitting right next to it.
 *
 * @param {string} content
 * @param {Map<string, string>} localPathByKey  Spec key → local blob path.
 * @param {{bucket: string, path: string}} ctx  Bucket the keys were built with.
 */
function localizeAttachments(content, localPathByKey, bucket = "user-files") {
  if (!localPathByKey?.size) return content;

  return sourceText.rewriteAttachments(content, (attachment) => {
    const next = { ...attachment };
    let touched = false;

    for (const spec of ATTACHMENT_BLOBS) {
      const cloudPath = attachment?.[spec.field];
      if (!cloudPath) continue;
      const local = localPathByKey.get(`${bucket}/${String(cloudPath)}`);
      if (!local) continue;
      next[spec.field] = local;
      touched = true;
    }

    if (touched) {
      next.storageBucket = LOCAL_BUCKET;
      if (next.url) delete next.url;
    }
    return next;
  });
}

/**
 * Map one `vault_items` row onto a local `items` row.
 *
 * @param {object} row
 * @returns {{item: object, blobs: ReturnType<typeof collectBlobSpecs>}}
 */
function mapVaultItem(row = {}) {
  const id = String(row.id || "");
  if (!id) throw new Error("vault item has no id");

  const blobs = collectBlobSpecs(row);

  const item = {
    id,
    kind: "vault",
    title: row.title ?? null,
    content: row.content ?? null,
    why: row.why ?? null,
    tags: asArray(row.tags),
    source: row.source ?? null,
    folder: row.folder ?? null,
    att_type: row.att_type ?? null,
    platform: row.platform ?? null,
    url: row.url ?? null,
    mime_type: row.mime_type ?? null,
    byte_size: numberOrNull(row.byte_size),
    duration_seconds: numberOrNull(row.duration_seconds),
    page_count: numberOrNull(row.page_count),
    host_name: row.host_name ?? null,
    media_width: numberOrNull(row.media_width),
    media_height: numberOrNull(row.media_height),
    preview: row.attachment_preview ?? null,
    comments: asArray(row.comments),
    ai_summary: row.ai_summary ?? null,
    ai_signals: row.ai_signals ?? null,
    origin: ORIGIN,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at ?? row.created_at ?? null,

    // Deliberately left unset until the bytes are actually on disk. Pointing a
    // row at a local file that was never downloaded would render as a broken
    // image and, worse, look successfully migrated.
    blob_path: null,
    variant_med: null,
    variant_thumb: null,
  };

  // `storage_bucket` and `ai_content_hash` have no local equivalent: there is
  // one bucket and the hash only ever guarded a cloud cache.
  return { item, blobs };
}

/**
 * Pull an ordered transcript out of a `lykn_chat_states.state` blob.
 *
 * `chatMessages` is the rich UI stream and is preferred because it carries
 * attachments, message kinds, and ids. `aiThread` is the flattened transcript
 * sent to the model and is the fallback for older snapshots that only have it.
 */
function messagesFromState(state = {}, { threadId, createdAt } = {}) {
  const rich = Array.isArray(state.chatMessages) ? state.chatMessages : [];
  const flat = Array.isArray(state.aiThread) ? state.aiThread : [];
  const source = rich.length ? rich : flat;
  const base = createdAt ? Date.parse(createdAt) : Date.now();

  return source
    .map((msg, index) => {
      if (!msg || typeof msg !== "object") return null;
      const role = String(msg.role || "user");
      const content = msg.content == null ? "" : String(msg.content);

      // Everything the local columns cannot hold — attachments, kind, tool
      // payloads, artifacts — is kept in `blocks` rather than dropped. A
      // migration that quietly loses a generated image is worse than one that
      // stores something the UI has to learn to read.
      const { role: _r, content: _c, id: _i, createdAt: _ca, created_at: _cb, ...rest } = msg;
      const extras = Object.keys(rest).length ? rest : null;

      if (!content && !extras) return null;

      return {
        id: msg.id ? String(msg.id) : undefined,
        thread_id: threadId,
        seq: index,
        role,
        content,
        blocks: extras,
        // Snapshots rarely stamp every message; ordering is what matters, so
        // synthesize a monotonic time from the chat's own creation instant.
        created_at: msg.createdAt || msg.created_at || new Date(base + index).toISOString(),
      };
    })
    .filter(Boolean);
}

/**
 * The parts of a snapshot that are not the conversation: the grid canvas and
 * its notes pages. Kept verbatim on `threads.state`.
 */
function canvasFromState(state = {}) {
  const { chatMessages: _cm, aiThread: _at, ...canvas } = state || {};
  return Object.keys(canvas).length ? canvas : null;
}

/**
 * Map a `lykn_chats` row plus its `lykn_chat_states` row into a local thread
 * and its messages.
 *
 * @param {object} chat  Row from lykn_chats.
 * @param {object} [stateRow] Row from lykn_chat_states (may be absent).
 */
function mapChat(chat = {}, stateRow = null) {
  const id = String(chat.id || "");
  if (!id) throw new Error("chat has no id");

  const state = stateRow?.state && typeof stateRow.state === "object" ? stateRow.state : {};
  const createdAt = chat.created_at || new Date().toISOString();

  const thread = {
    id,
    title: chat.title ?? state.title ?? null,
    // `studioMode` records which Studio surface the chat was last in; it is
    // the closest thing the cloud has to the local `mode`.
    mode: String(state.studioMode || chat.mode || "chat"),
    state: canvasFromState(state),
    origin: ORIGIN,
    created_at: createdAt,
    updated_at: chat.updated_at || createdAt,
  };

  return { thread, messages: messagesFromState(state, { threadId: id, createdAt }) };
}

/**
 * Local blob path for a downloaded object. The cloud key is
 * `{user_id}/{file_id}/original.ext`; on one device the user prefix is
 * meaningless and the file id is redundant with the row, so only the extension
 * carries over.
 */
function blobFilename(cloudPath, variant) {
  const name = String(cloudPath || "").split("/").pop() || "";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return { variant, extension: ext || null, filename: name || null };
}

module.exports = {
  mapVaultItem,
  mapChat,
  collectBlobSpecs,
  localizeAttachments,
  messagesFromState,
  canvasFromState,
  blobFilename,
  asArray,
  ORIGIN,
  LOCAL_BUCKET,
  COLUMN_BLOBS,
  ATTACHMENT_BLOBS,
};
